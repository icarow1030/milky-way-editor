import {
  CATALOG_FORMAT_VERSION, META_RECORD_BYTES, RENDER_BYTES_PER_STAR, readMetaRecord,
  type CatalogIndex, type CatalogNode, type NameRow, type StarMeta,
} from '../core/format.ts';

export type NodeState = 'idle' | 'loading' | 'loaded' | 'error';

/** One loaded octree node. `positions`/`rgbm` are views on a single fetched ArrayBuffer and are
 *  handed to the GPU as-is (no copies). The CPU copy is kept for picking. */
export interface LoadedNode {
  node: CatalogNode;
  index: number;
  positions: Float32Array;
  rgbm: Uint8Array;
  props: Uint8Array; // class, luminosity, BP−RP, flags (core/spectral.ts)
  bytes: number;
  lastUsed: number;
}

const BASE = `${import.meta.env.BASE_URL}data/catalog`;

/**
 * Owns the catalog index and an LRU cache of node payloads with a byte budget.
 * Knows nothing about Three.js: the renderer subscribes via onLoad/onUnload.
 */
export class CatalogStore {
  index!: CatalogIndex;
  readonly loaded = new Map<number, LoadedNode>();
  private readonly state = new Map<number, NodeState>();
  private inFlight = 0;
  private frame = 0;
  private metaCache = new Map<number, DataView>(); // small, LRU by insertion order
  private names: Promise<NameRow[]> | null = null;
  residentBytes = 0;

  onLoad: (n: LoadedNode) => void = () => {};
  onUnload: (n: LoadedNode) => void = () => {};

  constructor(public budgetBytes = 64 * 1024 * 1024, public maxConcurrent = 4) {}

  async init(): Promise<void> {
    const res = await fetch(`${BASE}/index.json`);
    if (!res.ok) throw new Error(`Catalog index not found (${res.status}). Run "npm run data" or "npm run data:sample".`);
    this.index = await res.json();
    if (this.index.version !== CATALOG_FORMAT_VERSION) {
      throw new Error(`Catalog format v${this.index.version} is outdated (expected v${CATALOG_FORMAT_VERSION}). Run "npm run data:build".`);
    }
  }

  get loading(): number {
    return this.inFlight;
  }

  stateOf(i: number): NodeState {
    return this.state.get(i) ?? 'idle';
  }

  /** Called once per frame with the set of node indices the view wants, in priority order. */
  update(wanted: number[]): void {
    this.frame++;
    for (const i of wanted) {
      const l = this.loaded.get(i);
      if (l) l.lastUsed = this.frame;
    }
    for (const i of wanted) {
      if (this.inFlight >= this.maxConcurrent) break;
      if (this.stateOf(i) === 'idle') void this.load(i);
    }
    this.evict(new Set(wanted));
  }

  private async load(i: number): Promise<void> {
    const node = this.index.nodes[i];
    this.state.set(i, 'loading');
    this.inFlight++;
    try {
      const res = await fetch(`${BASE}/nodes/${node.id}.bin`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength !== node.n * RENDER_BYTES_PER_STAR) throw new Error(`size mismatch for ${node.id}`);
      if (this.state.get(i) !== 'loading') return; // cancelled
      const l: LoadedNode = {
        node, index: i,
        positions: new Float32Array(buf, 0, node.n * 3),
        rgbm: new Uint8Array(buf, node.n * 12, node.n * 4),
        props: new Uint8Array(buf, node.n * 16, node.n * 4),
        bytes: buf.byteLength,
        lastUsed: this.frame,
      };
      this.loaded.set(i, l);
      this.state.set(i, 'loaded');
      this.residentBytes += l.bytes;
      this.onLoad(l);
    } catch (e) {
      console.warn('node load failed', node.id, e);
      this.state.set(i, 'error');
    } finally {
      this.inFlight--;
    }
  }

  /** Unload nodes that are not wanted when over budget (least recently used first). Never evicts the root. */
  private evict(wanted: Set<number>): void {
    // Unwanted nodes are released once they have been unused for a while, even under budget,
    // so memory tracks the current view; under pressure they go immediately.
    const idleFrames = this.residentBytes > this.budgetBytes * 0.75 ? 0 : 600;
    const candidates = [...this.loaded.values()]
      .filter((l) => l.index !== 0 && !wanted.has(l.index) && this.frame - l.lastUsed > idleFrames)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const l of candidates) {
      if (idleFrames === 0 && this.residentBytes <= this.budgetBytes * 0.75) break;
      this.unload(l);
    }
    // Hard budget: if still over, drop wanted nodes too, deepest first.
    if (this.residentBytes > this.budgetBytes) {
      const deep = [...this.loaded.values()].filter((l) => l.index !== 0).sort((a, b) => b.node.depth - a.node.depth);
      for (const l of deep) {
        if (this.residentBytes <= this.budgetBytes) break;
        this.unload(l);
      }
    }
  }

  private unload(l: LoadedNode): void {
    this.loaded.delete(l.index);
    this.state.set(l.index, 'idle');
    this.residentBytes -= l.bytes;
    this.onUnload(l);
  }

  /** Maps a global star index to (node index, local index) by binary search over node offsets. */
  locate(globalIndex: number): { node: number; local: number } | null {
    const nodes = this.index.nodes;
    // nodes are written in DFS order with increasing offsets
    let lo = 0, hi = nodes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = nodes[mid];
      if (globalIndex < n.off) hi = mid - 1;
      else if (globalIndex >= n.off + n.n) lo = mid + 1;
      else return { node: mid, local: globalIndex - n.off };
    }
    return null;
  }

  /** Fetches the metadata record of one star (node metadata file is cached, max 8 nodes). */
  async meta(globalIndex: number): Promise<StarMeta | null> {
    const loc = this.locate(globalIndex);
    if (!loc) return null;
    let view = this.metaCache.get(loc.node);
    if (!view) {
      const res = await fetch(`${BASE}/nodes/${this.index.nodes[loc.node].id}.meta.bin`);
      if (!res.ok) return null;
      view = new DataView(await res.arrayBuffer());
      this.metaCache.set(loc.node, view);
      if (this.metaCache.size > 8) this.metaCache.delete(this.metaCache.keys().next().value!);
    }
    return readMetaRecord(view, loc.local, globalIndex);
  }

  get metaCacheBytes(): number {
    let b = 0;
    for (const v of this.metaCache.values()) b += v.byteLength;
    return b;
  }

  /** Designations, loaded lazily (first search or selection). */
  loadNames(): Promise<NameRow[]> {
    if (!this.names) this.names = fetch(`${BASE}/names.json`).then((r) => (r.ok ? r.json() : []));
    return this.names;
  }

  /** Filter props (class, luminosity, BP−RP, flags) of one star, fetching its node payload if needed. */
  async propsOf(globalIndex: number): Promise<[number, number, number, number] | null> {
    const loc = this.locate(globalIndex);
    if (!loc) return null;
    const node = this.index.nodes[loc.node];
    let p = this.loaded.get(loc.node)?.props;
    if (!p) {
      const res = await fetch(`${BASE}/nodes/${node.id}.bin`);
      if (!res.ok) return null;
      p = new Uint8Array(await res.arrayBuffer(), node.n * 16, node.n * 4);
    }
    const o = loc.local * 4;
    return [p[o], p[o + 1], p[o + 2], p[o + 3]];
  }

  /** World position (float64) of a star; requires its node loaded or loads it. */
  async worldPosition(globalIndex: number): Promise<[number, number, number] | null> {
    const loc = this.locate(globalIndex);
    if (!loc) return null;
    const l = this.loaded.get(loc.node);
    const node = this.index.nodes[loc.node];
    let p: Float32Array;
    if (l) p = l.positions;
    else {
      const res = await fetch(`${BASE}/nodes/${node.id}.bin`);
      p = new Float32Array(await res.arrayBuffer(), 0, node.n * 3);
    }
    return [node.c[0] + p[loc.local * 3], node.c[1] + p[loc.local * 3 + 1], node.c[2] + p[loc.local * 3 + 2]];
  }
}

export { META_RECORD_BYTES };
