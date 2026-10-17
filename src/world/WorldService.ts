import {
  buildWorldFile, cloneWithNewIds, coerceValue, createEntity, createWorld, migrateFieldValues, parseWorldFile,
  sanitizeFieldDef, sanitizeTag, TAG_PALETTE,
  type Entity, type FieldDef, type FieldValue, type StarAnchor, type TagDef, type WorldFile, type WorldMeta,
} from './model.ts';
import type { WorldRepo } from './repo.ts';

export type WorldEvent =
  | { type: 'worlds' } // list of worlds changed
  | { type: 'active' } // a different world is active (everything changed)
  | { type: 'meta' } // name/description/tags/fields of the active world
  | { type: 'entities'; ids: string[] }
  | { type: 'resolved' } // anchors re-linked to the current catalogue
  | { type: 'saved' }
  | { type: 'error'; message: string };

export type EntityPatch = Partial<Pick<Entity, 'name' | 'description' | 'tags'>> & {
  fields?: Record<string, FieldValue | undefined>;
};

/** Finds the current catalogue index of a star from any of its identifiers. */
export type AnchorResolver = (ids: string[]) => Promise<number | null>;

interface Options {
  catalogBuild: () => string | null;
  resolve: AnchorResolver | null;
  saveDelayMs?: number;
  broadcast?: boolean;
}

/**
 * Keeps the active world in memory, persists changes (debounced) through a WorldRepo, and
 * notifies listeners. All mutations go through here so that cascades (deleting a tag or a field,
 * changing a field's type) are applied consistently.
 */
export class WorldService {
  worlds: WorldMeta[] = [];
  active: WorldMeta | null = null;
  readonly entities = new Map<string, Entity>();
  /** catalogue index (current build) -> entity anchored to that star */
  private byIndex = new Map<number, Entity>();
  /** entities whose star is not in the current catalogue */
  readonly orphans = new Set<string>();
  private listeners = new Set<(e: WorldEvent) => void>();
  private pendingPut = new Map<string, Entity>();
  private pendingDel = new Set<string>();
  private metaDirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private channel: BroadcastChannel | null = null;
  private readonly delay: number;
  readonly repo: WorldRepo;
  private opts: Options;

  constructor(repo: WorldRepo, opts: Options) {
    this.repo = repo;
    this.opts = opts;
    this.delay = opts.saveDelayMs ?? 350;
    if (opts.broadcast && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('galactic-atlas-world');
      this.channel.onmessage = (m) => void this.onRemoteChange(m.data);
    }
  }

  on(fn: (e: WorldEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: WorldEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  // ---------------------------------------------------------------- worlds

  /** Loads the world list and activates `preferredId` (or the most recent; creates one if none). */
  async init(preferredId?: string | null): Promise<void> {
    this.worlds = sortWorlds(await this.repo.listWorlds());
    if (!this.worlds.length) {
      const w = createWorld('Meu universo');
      await this.repo.putWorld(w);
      this.worlds = [w];
    }
    const target = this.worlds.find((w) => w.id === preferredId) ?? this.worlds[0];
    await this.loadActive(target.id);
    this.emit({ type: 'worlds' });
  }

  private async loadActive(id: string): Promise<void> {
    await this.flush();
    const w = this.worlds.find((x) => x.id === id);
    if (!w) throw new Error(`Mundo ${id} não encontrado`);
    const loaded = await this.repo.loadEntities(id);
    this.active = structuredClone(w);
    this.entities.clear();
    for (const e of loaded) this.entities.set(e.id, e);
    this.rebuildIndex();
    this.emit({ type: 'active' });
    await this.resolveAnchors();
  }

  async setActive(id: string): Promise<void> {
    if (this.active?.id === id) return;
    await this.loadActive(id);
  }

  async createWorld(name: string): Promise<WorldMeta> {
    const w = createWorld(name);
    await this.repo.putWorld(w);
    this.worlds = sortWorlds([...this.worlds, w]);
    this.emit({ type: 'worlds' });
    await this.loadActive(w.id);
    return w;
  }

  updateWorld(patch: Partial<Pick<WorldMeta, 'name' | 'description'>>): void {
    if (!this.active) return;
    if (patch.name !== undefined) this.active.name = patch.name.trim() || 'Sem nome';
    if (patch.description !== undefined) this.active.description = patch.description;
    this.touchMeta();
    this.emit({ type: 'meta' });
  }

  async duplicateWorld(id: string): Promise<WorldMeta> {
    await this.flush();
    const src = this.worlds.find((w) => w.id === id);
    if (!src) throw new Error('Mundo não encontrado');
    const file = cloneWithNewIds(buildWorldFile(src, await this.repo.loadEntities(id), this.opts.catalogBuild()));
    await this.repo.replaceWorld(file.world, file.entities);
    this.worlds = sortWorlds([...this.worlds, file.world]);
    this.emit({ type: 'worlds' });
    return file.world;
  }

  async deleteWorld(id: string): Promise<void> {
    if (this.active?.id === id) {
      // drop unsaved edits of the world being deleted
      this.pendingPut.clear();
      this.pendingDel.clear();
      this.metaDirty = false;
    }
    await this.flush();
    await this.repo.deleteWorld(id);
    this.worlds = this.worlds.filter((w) => w.id !== id);
    this.broadcast(id);
    if (this.active?.id === id) {
      this.active = null;
      await this.init(null);
    } else this.emit({ type: 'worlds' });
  }

  // ---------------------------------------------------------------- entities

  entityForStar(index: number): Entity | undefined {
    return this.byIndex.get(index);
  }

  /** Current catalogue index of an anchored entity, or null if orphaned/unresolved. */
  indexOf(e: Entity): number | null {
    if (!e.anchor || this.orphans.has(e.id)) return null;
    return e.anchor.catalogBuild === this.opts.catalogBuild() && e.anchor.index >= 0 ? e.anchor.index : null;
  }

  annotate(anchor: StarAnchor): Entity {
    if (!this.active) throw new Error('Nenhum mundo ativo');
    const existing = this.byIndex.get(anchor.index);
    if (existing) return existing;
    const e = createEntity(this.active.id, 'star', anchor);
    this.entities.set(e.id, e);
    this.byIndex.set(anchor.index, e);
    this.queuePut(e);
    this.emit({ type: 'entities', ids: [e.id] });
    return e;
  }

  updateEntity(id: string, patch: EntityPatch): Entity | null {
    const cur = this.entities.get(id);
    if (!cur || !this.active) return null;
    const next: Entity = { ...cur, fields: { ...cur.fields }, updatedAt: Date.now(), rev: cur.rev + 1 };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.tags !== undefined) {
      const known = new Set(this.active.tags.map((t) => t.id));
      next.tags = [...new Set(patch.tags.filter((t) => known.has(t)))];
    }
    if (patch.fields) {
      for (const [k, v] of Object.entries(patch.fields)) {
        const def = this.active.fields.find((f) => f.id === k);
        const c = def ? coerceValue(def, v) : undefined;
        if (c === undefined) delete next.fields[k];
        else next.fields[k] = c;
      }
    }
    this.entities.set(id, next);
    if (next.anchor) this.reindex(next);
    this.queuePut(next);
    this.emit({ type: 'entities', ids: [id] });
    return next;
  }

  removeEntity(id: string): void {
    const e = this.entities.get(id);
    if (!e) return;
    this.entities.delete(id);
    this.orphans.delete(id);
    for (const [k, v] of this.byIndex) if (v.id === id) this.byIndex.delete(k);
    this.pendingPut.delete(id);
    this.pendingDel.add(id);
    this.schedule();
    this.emit({ type: 'entities', ids: [id] });
  }

  // ---------------------------------------------------------------- tags

  addTag(name: string, color?: string): TagDef {
    if (!this.active) throw new Error('Nenhum mundo ativo');
    const t = sanitizeTag({ name, color: color ?? TAG_PALETTE[this.active.tags.length % TAG_PALETTE.length] });
    this.active.tags.push(t);
    this.touchMeta();
    this.emit({ type: 'meta' });
    return t;
  }

  updateTag(id: string, patch: Partial<Pick<TagDef, 'name' | 'color'>>): void {
    const t = this.active?.tags.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, sanitizeTag({ ...t, ...patch }));
    this.touchMeta();
    this.emit({ type: 'meta' });
  }

  deleteTag(id: string): void {
    if (!this.active) return;
    this.active.tags = this.active.tags.filter((t) => t.id !== id);
    const ids: string[] = [];
    for (const e of this.entities.values()) {
      if (!e.tags.includes(id)) continue;
      const next = { ...e, tags: e.tags.filter((t) => t !== id), updatedAt: Date.now(), rev: e.rev + 1 };
      this.entities.set(e.id, next);
      this.reindex(next);
      this.queuePut(next);
      ids.push(e.id);
    }
    this.touchMeta();
    this.emit({ type: 'meta' });
    if (ids.length) this.emit({ type: 'entities', ids });
  }

  // ---------------------------------------------------------------- fields

  addField(raw: Partial<FieldDef>): FieldDef {
    if (!this.active) throw new Error('Nenhum mundo ativo');
    const d = sanitizeFieldDef({ ...raw, id: undefined }, new Set(this.active.fields.map((f) => f.id)));
    this.active.fields.push(d);
    this.touchMeta();
    this.emit({ type: 'meta' });
    return d;
  }

  /** Updates a field definition and converts stored values (option renames are followed). */
  updateField(id: string, patch: Partial<Omit<FieldDef, 'id'>>, renames: Record<string, string> = {}): void {
    if (!this.active) return;
    const i = this.active.fields.findIndex((f) => f.id === id);
    if (i < 0) return;
    const def = sanitizeFieldDef({ ...this.active.fields[i], ...patch, id }, new Set());
    this.active.fields[i] = def;
    const changed = migrateFieldValues([...this.entities.values()], def, renames);
    for (const e of changed) {
      const next = { ...e, updatedAt: Date.now(), rev: e.rev + 1 };
      this.entities.set(e.id, next);
      this.reindex(next);
      this.queuePut(next);
    }
    this.touchMeta();
    this.emit({ type: 'meta' });
    if (changed.length) this.emit({ type: 'entities', ids: changed.map((e) => e.id) });
  }

  moveField(id: string, delta: -1 | 1): void {
    const f = this.active?.fields;
    if (!f) return;
    const i = f.findIndex((x) => x.id === id), j = i + delta;
    if (i < 0 || j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j], f[i]];
    this.touchMeta();
    this.emit({ type: 'meta' });
  }

  deleteField(id: string): void {
    if (!this.active) return;
    this.active.fields = this.active.fields.filter((f) => f.id !== id);
    const ids: string[] = [];
    for (const e of this.entities.values()) {
      if (!(id in e.fields)) continue;
      const fields = { ...e.fields };
      delete fields[id];
      const next = { ...e, fields, updatedAt: Date.now(), rev: e.rev + 1 };
      this.entities.set(e.id, next);
      this.reindex(next);
      this.queuePut(next);
      ids.push(e.id);
    }
    this.touchMeta();
    this.emit({ type: 'meta' });
    if (ids.length) this.emit({ type: 'entities', ids });
  }

  usage(kind: 'tag' | 'field', id: string): number {
    let n = 0;
    for (const e of this.entities.values()) if (kind === 'tag' ? e.tags.includes(id) : id in e.fields) n++;
    return n;
  }

  // ---------------------------------------------------------------- import / export

  async exportWorld(id = this.active?.id): Promise<WorldFile> {
    await this.flush();
    const w = this.worlds.find((x) => x.id === id);
    if (!w) throw new Error('Mundo não encontrado');
    return buildWorldFile(w, await this.repo.loadEntities(w.id), this.opts.catalogBuild());
  }

  hasWorld(id: string): boolean {
    return this.worlds.some((w) => w.id === id);
  }

  /** Imports a parsed file. 'replace' overwrites a world with the same id; 'copy' gets new ids. */
  async importWorld(raw: unknown, mode: 'replace' | 'copy'): Promise<WorldMeta> {
    let file = parseWorldFile(raw);
    if (mode === 'copy' && this.hasWorld(file.world.id)) file = cloneWithNewIds(file);
    if (mode === 'replace' && this.active?.id === file.world.id) {
      this.pendingPut.clear();
      this.pendingDel.clear();
      this.metaDirty = false;
    }
    await this.flush();
    file.world.updatedAt = Date.now();
    await this.repo.replaceWorld(file.world, file.entities);
    this.worlds = sortWorlds([...this.worlds.filter((w) => w.id !== file.world.id), file.world]);
    this.broadcast(file.world.id);
    this.emit({ type: 'worlds' });
    this.active = null;
    await this.loadActive(file.world.id);
    return file.world;
  }

  // ---------------------------------------------------------------- persistence

  private touchMeta(): void {
    if (!this.active) return;
    this.active.updatedAt = Date.now();
    this.metaDirty = true;
    this.schedule();
  }

  private queuePut(e: Entity): void {
    this.pendingDel.delete(e.id);
    this.pendingPut.set(e.id, e);
    if (this.active) this.active.updatedAt = Date.now();
    this.metaDirty = true; // keeps the world's updatedAt current
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }

  get dirty(): boolean {
    return this.metaDirty || this.pendingPut.size > 0 || this.pendingDel.size > 0;
  }

  /** Writes pending changes now. Safe to call repeatedly; writes are serialised. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || !this.active) return this.saving;
    const w = structuredClone(this.active);
    const put = [...this.pendingPut.values()];
    const del = [...this.pendingDel];
    const writeMeta = this.metaDirty;
    this.pendingPut.clear();
    this.pendingDel.clear();
    this.metaDirty = false;
    this.saving = this.saving.then(async () => {
      try {
        if (put.length || del.length) await this.repo.commit(w.id, put, del);
        if (writeMeta) {
          await this.repo.putWorld(w);
          this.worlds = sortWorlds(this.worlds.map((x) => (x.id === w.id ? w : x)));
          this.emit({ type: 'worlds' });
        }
        this.broadcast(w.id);
        this.emit({ type: 'saved' });
      } catch (err) {
        // put the changes back so the next flush retries them
        for (const e of put) if (!this.pendingPut.has(e.id)) this.pendingPut.set(e.id, e);
        for (const id of del) this.pendingDel.add(id);
        this.metaDirty ||= writeMeta;
        this.emit({ type: 'error', message: `Falha ao salvar: ${(err as Error).message ?? err}` });
      }
    });
    return this.saving;
  }

  private broadcast(worldId: string): void {
    this.channel?.postMessage({ worldId });
  }

  /** Another tab changed a world: refresh the list and, if it is ours and we have no pending edits, reload it. */
  private async onRemoteChange(data: { worldId?: string }): Promise<void> {
    this.worlds = sortWorlds(await this.repo.listWorlds());
    this.emit({ type: 'worlds' });
    if (!this.active || data?.worldId !== this.active.id || this.dirty) return;
    if (!this.worlds.some((w) => w.id === this.active!.id)) {
      this.active = null;
      await this.init(null);
      return;
    }
    this.active = null;
    await this.loadActive(data.worldId);
  }

  // ---------------------------------------------------------------- anchors

  private rebuildIndex(): void {
    this.byIndex.clear();
    for (const e of this.entities.values()) this.reindex(e);
  }

  private reindex(e: Entity): void {
    const i = this.indexOf(e);
    if (i !== null) this.byIndex.set(i, e);
  }

  /** Re-links anchors created against another catalogue build; unresolvable ones become orphans. */
  async resolveAnchors(): Promise<void> {
    const build = this.opts.catalogBuild();
    const resolve = this.opts.resolve;
    if (!build || !resolve || !this.active) return;
    const worldId = this.active.id;
    const stale = [...this.entities.values()].filter((e) => e.anchor && e.anchor.catalogBuild !== build);
    if (!stale.length) return;
    const ids: string[] = [];
    for (const e of stale) {
      const index = await resolve(e.anchor!.ids);
      if (this.active?.id !== worldId) return; // world switched meanwhile
      const cur = this.entities.get(e.id);
      if (!cur?.anchor) continue;
      if (index === null) {
        this.orphans.add(e.id);
        continue;
      }
      this.orphans.delete(e.id);
      const next = { ...cur, anchor: { ...cur.anchor, index, catalogBuild: build } };
      this.entities.set(e.id, next);
      this.reindex(next);
      this.queuePut(next);
      ids.push(e.id);
    }
    this.emit({ type: 'resolved' });
    if (ids.length) this.emit({ type: 'entities', ids });
  }
}

const sortWorlds = (ws: WorldMeta[]) => [...ws].sort((a, b) => b.updatedAt - a.updatedAt);
