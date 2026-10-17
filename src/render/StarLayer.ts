import * as THREE from 'three';
import type { CatalogStore, LoadedNode } from '../catalog/CatalogStore.ts';
import type { Vec3 } from '../core/coords.ts';
import { ABSMAG_MIN, ABSMAG_STEP } from '../core/photometry.ts';
import { COLOR_MIN, COLOR_STEP, COLOR_UNKNOWN, PropFlag } from '../core/spectral.ts';
import { RENDER_BYTES_PER_STAR } from '../core/format.ts';

/**
 * Observational stars: one THREE.Points per loaded octree node, sharing one shader program.
 * Positions are node-relative float32; each frame the node's object position is set to
 * (node centre − camera) computed in float64, so the GPU only sees camera-relative values.
 */

/** Star filter over the per-star props. Bit i of classMask/lumMask = SpecClass/LumClass i. */
export interface StarFilter {
  classMask: number;
  lumMask: number;
  catalogued: boolean; // spectral class taken from a catalogue
  estimated: boolean; // spectral class estimated from photometry
  mMin: number; // absolute magnitude (M_G for Gaia, M_V for HYG)
  mMax: number;
  cMin: number; // BP−RP
  cMax: number;
  mode: 'hide' | 'dim';
}
export const ABSMAG_RANGE: [number, number] = [-12, 20];
export const COLOR_RANGE: [number, number] = [-0.6, 5.75];
export const defaultFilter = (): StarFilter => ({
  classMask: 0x7ff, lumMask: 0xff, catalogued: true, estimated: true,
  mMin: ABSMAG_RANGE[0], mMax: ABSMAG_RANGE[1], cMin: COLOR_RANGE[0], cMax: COLOR_RANGE[1], mode: 'hide',
});
export function filterActive(f: StarFilter): boolean {
  const d = defaultFilter();
  return f.classMask !== d.classMask || f.lumMask !== d.lumMask || !f.catalogued || !f.estimated
    || f.mMin > d.mMin || f.mMax < d.mMax || f.cMin > d.cMin || f.cMax < d.cMax;
}
const colorActive = (f: StarFilter) => f.cMin > COLOR_RANGE[0] || f.cMax < COLOR_RANGE[1];

/** CPU mirror of the shader filter (kept in sync with VERT below). */
export function passesFilter(f: StarFilter, props: Uint8Array, rgbmA: number, k: number): boolean {
  const cls = props[k * 4], lum = props[k * 4 + 1], cq = props[k * 4 + 2], fl = props[k * 4 + 3];
  if (!((f.classMask >> cls) & 1) || !((f.lumMask >> lum) & 1)) return false;
  if (fl & PropFlag.ClassEstimated ? !f.estimated : !f.catalogued) return false;
  const M = ABSMAG_MIN + rgbmA * ABSMAG_STEP;
  if (M < f.mMin || M > f.mMax) return false;
  if (cq === COLOR_UNKNOWN) return !colorActive(f);
  const c = COLOR_MIN + cq * COLOR_STEP;
  return c >= f.cMin - 1e-4 && c <= f.cMax + 1e-4;
}

export interface FilterStats {
  total: number;
  passing: number;
  byClass: number[];
  byLum: number[];
}

const VERT = /* glsl */ `
  attribute vec4 rgbm;
  attribute vec4 props;
  uniform float uMagLimit;
  uniform float uPixelRatio;
  uniform int uHide;
  uniform int uFilterOn;   // per material: 0 for the focused star
  uniform int uClassMask;
  uniform int uLumMask;
  uniform int uProvMask;   // bit0 catalogued class, bit1 estimated class
  uniform int uColorActive;
  uniform vec4 uRanges;    // M min, M max, BP-RP min, BP-RP max
  uniform float uDim;      // 0: hide filtered-out stars, >0: dim them
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(length(mv.xyz), 1e-9);
    float M = ${ABSMAG_MIN.toFixed(1)} + rgbm.a * 255.0 * ${ABSMAG_STEP.toFixed(4)};
    float m = M + 5.0 * log(d * 0.1) / log(10.0);
    float dm = uMagLimit - m;
    bool pass = true;
    if (uFilterOn == 1) {
      int cls = int(props.x * 255.0 + 0.5);
      int lum = int(props.y * 255.0 + 0.5);
      int cq = int(props.z * 255.0 + 0.5);
      int fl = int(props.w * 255.0 + 0.5);
      int prov = (fl & 1) == 1 ? 2 : 1;
      pass = ((uClassMask >> cls) & 1) == 1 && ((uLumMask >> lum) & 1) == 1 && (uProvMask & prov) != 0
        && M >= uRanges.x && M <= uRanges.y;
      if (cq == ${COLOR_UNKNOWN}) pass = pass && uColorActive == 0;
      else {
        float c = ${COLOR_MIN.toFixed(3)} + float(cq) * ${COLOR_STEP.toFixed(4)};
        pass = pass && c >= uRanges.z - 1e-4 && c <= uRanges.w + 1e-4;
      }
    }
    if (dm < 0.0 || gl_VertexID == uHide || (!pass && uDim <= 0.0)) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vColor = rgbm.rgb;
    // faint stars fade in over ~5.5 mag above the limit; only bright ones grow
    vAlpha = pow(clamp(dm / 5.5, 0.0, 1.0), 1.6) * 0.96 + 0.04;
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(1.5 + max(dm - 4.0, 0.0) * 0.8, 1.5, 9.0) * uPixelRatio;
    if (!pass) { vAlpha *= uDim; gl_PointSize = 1.5 * uPixelRatio; }
  }`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float f = exp(-r2 * 3.5);
    gl_FragColor = vec4(vColor * vAlpha * f, 1.0);
  }`;

/** CPU mirror of the shader's visibility test (used by picking and labels). */
export function apparentDelta(magLimit: number, rgbmA: number, dist: number): number {
  const M = ABSMAG_MIN + rgbmA * ABSMAG_STEP;
  return magLimit - (M + 5 * Math.log10(Math.max(dist, 1e-9) * 0.1));
}
export function pointSizePx(dm: number): number {
  return Math.min(Math.max(1.5 + Math.max(dm - 4, 0) * 0.8, 1.5), 9);
}

interface NodeObj {
  l: LoadedNode;
  points: THREE.Points;
  mat: THREE.ShaderMaterial;
}

export class StarLayer {
  readonly group = new THREE.Group();
  private objs = new Map<number, NodeObj>();
  private shared = {
    uMagLimit: { value: 6.5 }, uPixelRatio: { value: 1 },
    uClassMask: { value: 0x7ff }, uLumMask: { value: 0xff }, uProvMask: { value: 3 }, uColorActive: { value: 0 },
    uRanges: { value: new THREE.Vector4(ABSMAG_RANGE[0], ABSMAG_RANGE[1], COLOR_RANGE[0], COLOR_RANGE[1]) },
    uDim: { value: 0 },
  };
  private baseMat: THREE.ShaderMaterial;
  private focus: { points: THREE.Points; world: Vec3; index: number } | null = null;
  private filter: StarFilter = defaultFilter();
  private active = false;
  private stats: FilterStats | null = null;
  drawnStars = 0;
  gpuBytes = 0;

  constructor(private store: CatalogStore) {
    this.baseMat = new THREE.ShaderMaterial({
      uniforms: { ...this.shared, uHide: { value: -1 }, uFilterOn: { value: 1 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    store.onLoad = (l) => this.add(l);
    store.onUnload = (l) => this.remove(l.index);
  }

  get magLimit(): number {
    return this.shared.uMagLimit.value;
  }

  private makeMaterial(filterOn = true): THREE.ShaderMaterial {
    // Clone shares the compiled program; global uniforms are shared objects.
    const m = this.baseMat.clone();
    m.uniforms = { ...this.shared, uHide: { value: -1 }, uFilterOn: { value: filterOn ? 1 : 0 } };
    return m;
  }

  setFilter(f: StarFilter): void {
    this.filter = { ...f };
    this.active = filterActive(f);
    const u = this.shared;
    u.uClassMask.value = f.classMask;
    u.uLumMask.value = f.lumMask;
    u.uProvMask.value = (f.catalogued ? 1 : 0) | (f.estimated ? 2 : 0);
    u.uColorActive.value = colorActive(f) ? 1 : 0;
    u.uRanges.value.set(f.mMin, f.mMax, f.cMin, f.cMax);
    u.uDim.value = f.mode === 'dim' ? 0.12 : 0;
    this.stats = null;
  }

  get filterIsActive(): boolean {
    return this.active;
  }

  /** True if the star survives the filter (dimmed stars count as filtered out). */
  passes(nodeIndex: number, local: number): boolean {
    if (!this.active) return true;
    const l = this.store.loaded.get(nodeIndex);
    return !!l && passesFilter(this.filter, l.props, l.rgbm[local * 4 + 3], local);
  }

  /** Counts over resident stars (recomputed only after a filter or residency change). */
  filterStats(): FilterStats {
    if (this.stats) return this.stats;
    const st: FilterStats = { total: 0, passing: 0, byClass: new Array(11).fill(0), byLum: new Array(8).fill(0) };
    for (const { l } of this.objs.values()) {
      const p = l.props, r = l.rgbm;
      for (let k = 0; k < l.node.n; k++) {
        st.byClass[p[k * 4]]++;
        st.byLum[p[k * 4 + 1]]++;
        if (!this.active || passesFilter(this.filter, p, r[k * 4 + 3], k)) st.passing++;
      }
      st.total += l.node.n;
    }
    return (this.stats = st);
  }

  private add(l: LoadedNode): void {
    const geo = new THREE.BufferGeometry();
    // The typed arrays are views on the fetched buffer: uploaded once, kept once on the CPU (picking).
    geo.setAttribute('position', new THREE.BufferAttribute(l.positions, 3));
    geo.setAttribute('rgbm', new THREE.BufferAttribute(l.rgbm, 4, true));
    geo.setAttribute('props', new THREE.BufferAttribute(l.props, 4, true));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), l.node.h * Math.sqrt(3));
    const mat = this.makeMaterial();
    const points = new THREE.Points(geo, mat);
    points.matrixAutoUpdate = true;
    this.group.add(points);
    this.objs.set(l.index, { l, points, mat });
    this.gpuBytes += l.bytes;
    this.stats = null;
    if (this.focus) this.applyHide();
  }

  private remove(i: number): void {
    const o = this.objs.get(i);
    if (!o) return;
    this.group.remove(o.points);
    o.points.geometry.dispose();
    o.mat.dispose();
    this.objs.delete(i);
    this.gpuBytes -= o.l.bytes;
    this.stats = null;
  }

  /**
   * Draws `index` as a separate single point at an exact float64 world position, and hides it
   * in its node. This keeps the focused star rock-solid at AU-scale zoom even when its
   * node-relative float32 position is kiloparsecs from the node centre.
   */
  setFocus(index: number | null, world: Vec3 | null, rgbm: [number, number, number, number] | null): void {
    if (this.focus) {
      this.group.remove(this.focus.points);
      this.focus.points.geometry.dispose();
      this.focus = null;
    }
    if (index !== null && world && rgbm) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      geo.setAttribute('rgbm', new THREE.BufferAttribute(new Uint8Array(rgbm), 4, true));
      geo.setAttribute('props', new THREE.BufferAttribute(new Uint8Array(4), 4, true));
      // the selected star stays visible whatever the filter
      const p = new THREE.Points(geo, this.makeMaterial(false));
      p.frustumCulled = false;
      this.group.add(p);
      this.focus = { points: p, world, index };
    }
    this.applyHide();
  }

  private applyHide(): void {
    const loc = this.focus ? this.store.locate(this.focus.index) : null;
    for (const [i, o] of this.objs) o.mat.uniforms.uHide.value = loc && loc.node === i ? loc.local : -1;
  }

  update(cam: Vec3, magLimit: number, pixelRatio: number): void {
    this.shared.uMagLimit.value = magLimit;
    this.shared.uPixelRatio.value = pixelRatio;
    let drawn = 0;
    for (const o of this.objs.values()) {
      const c = o.l.node.c;
      o.points.position.set(c[0] - cam[0], c[1] - cam[1], c[2] - cam[2]);
      drawn += o.l.node.n;
    }
    if (this.focus) {
      const w = this.focus.world;
      this.focus.points.position.set(w[0] - cam[0], w[1] - cam[1], w[2] - cam[2]);
    }
    this.drawnStars = drawn;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /**
   * LOD selection: a node is wanted if it intersects the frustum and its brightest star could be
   * visible from the nearest point of its box (apparent mag < limit). Children only contain
   * fainter stars than their parent, so the traversal stops early.
   */
  wantedNodes(cam: Vec3, frustum: THREE.Frustum, magLimit: number, budget: number): number[] {
    const nodes = this.store.index.nodes;
    const out: Array<{ i: number; d: number }> = [];
    const box = new THREE.Box3();
    const stack = [0];
    let bytes = 0;
    while (stack.length) {
      const i = stack.pop()!;
      const n = nodes[i];
      const dx = Math.max(Math.abs(n.c[0] - cam[0]) - n.h, 0);
      const dy = Math.max(Math.abs(n.c[1] - cam[1]) - n.h, 0);
      const dz = Math.max(Math.abs(n.c[2] - cam[2]) - n.h, 0);
      const dmin = Math.hypot(dx, dy, dz);
      if (n.mMin + 5 * Math.log10(Math.max(dmin, 1e-6) * 0.1) > magLimit) continue;
      box.min.set(n.c[0] - n.h - cam[0], n.c[1] - n.h - cam[1], n.c[2] - n.h - cam[2]);
      box.max.set(n.c[0] + n.h - cam[0], n.c[1] + n.h - cam[1], n.c[2] + n.h - cam[2]);
      if (i !== 0 && !frustum.intersectsBox(box)) continue;
      out.push({ i, d: n.depth * 1e9 + dmin });
      for (const c of n.ch) stack.push(c);
    }
    out.sort((a, b) => a.d - b.d);
    const res: number[] = [];
    for (const o of out) {
      bytes += nodes[o.i].n * RENDER_BYTES_PER_STAR;
      if (bytes > budget) break;
      res.push(o.i);
    }
    return res;
  }

  /**
   * CPU picking in float64 over loaded nodes; only stars the shader actually shows are candidates.
   * Returns the global star index or null.
   */
  pick(px: number, py: number, cam: Vec3, camera: THREE.PerspectiveCamera, width: number, height: number,
    pixelRatio: number): number | null {
    const e = camera.matrixWorldInverse.elements; // rotation only (camera at origin)
    const p = camera.projectionMatrix.elements;
    const magLimit = this.shared.uMagLimit.value;
    const f = this.active ? this.filter : null;
    let best = -1, bestScore = Infinity;
    for (const { l, mat } of this.objs.values()) {
      const c = l.node.c;
      const ox = c[0] - cam[0], oy = c[1] - cam[1], oz = c[2] - cam[2];
      const pos = l.positions, rgbm = l.rgbm, props = l.props;
      const hide = mat.uniforms.uHide.value as number;
      for (let k = 0; k < l.node.n; k++) {
        if (k === hide) continue;
        const pass = !f || passesFilter(f, props, rgbm[k * 4 + 3], k);
        if (!pass && f!.mode === 'hide') continue;
        const x = ox + pos[k * 3], y = oy + pos[k * 3 + 1], z = oz + pos[k * 3 + 2];
        const vx = e[0] * x + e[4] * y + e[8] * z;
        const vy = e[1] * x + e[5] * y + e[9] * z;
        const vz = e[2] * x + e[6] * y + e[10] * z;
        if (vz >= 0) continue; // behind camera
        const d = Math.hypot(x, y, z);
        const dm = apparentDelta(magLimit, rgbm[k * 4 + 3], d);
        if (dm < 0) continue;
        const sx = ((p[0] * vx + p[8] * vz) / -vz * 0.5 + 0.5) * width;
        const sy = (0.5 - (p[5] * vy + p[9] * vz) / -vz * 0.5) * height;
        const dpx = Math.hypot(sx - px, sy - py);
        const radius = Math.max(7, ((pass ? pointSizePx(dm) : 1.5) * pixelRatio) / 2 + 4);
        if (dpx > radius) continue;
        // prefer brighter among close candidates; dimmed (filtered-out) stars only as a last resort
        const score = dpx - dm * 1.5 + (pass ? 0 : 1000);
        if (score < bestScore) { bestScore = score; best = l.node.off + k; }
      }
    }
    if (this.focus) {
      const w = this.focus.world;
      const s = this.project([w[0] - cam[0], w[1] - cam[1], w[2] - cam[2]], camera, width, height);
      if (s && Math.hypot(s[0] - px, s[1] - py) < 10) return this.focus.index;
    }
    return best >= 0 ? best : null;
  }

  /** Projects a camera-relative vector to screen pixels (null if behind). */
  project(rel: Vec3, camera: THREE.PerspectiveCamera, width: number, height: number): [number, number] | null {
    const e = camera.matrixWorldInverse.elements;
    const p = camera.projectionMatrix.elements;
    const [x, y, z] = rel;
    const vx = e[0] * x + e[4] * y + e[8] * z;
    const vy = e[1] * x + e[5] * y + e[9] * z;
    const vz = e[2] * x + e[6] * y + e[10] * z;
    if (vz >= 0) return null;
    return [((p[0] * vx + p[8] * vz) / -vz * 0.5 + 0.5) * width, (0.5 - (p[5] * vy + p[9] * vz) / -vz * 0.5) * height];
  }

  /** rgbm of a star if its node is loaded. */
  rgbmOf(index: number): [number, number, number, number] | null {
    const loc = this.store.locate(index);
    const l = loc ? this.store.loaded.get(loc.node) : undefined;
    if (!loc || !l) return null;
    const o = loc.local * 4;
    return [l.rgbm[o], l.rgbm[o + 1], l.rgbm[o + 2], l.rgbm[o + 3]];
  }

  /** props (class, luminosity, BP−RP, flags) of a star if its node is loaded. */
  propsOf(index: number): [number, number, number, number] | null {
    const loc = this.store.locate(index);
    const l = loc ? this.store.loaded.get(loc.node) : undefined;
    if (!loc || !l) return null;
    const o = loc.local * 4;
    return [l.props[o], l.props[o + 1], l.props[o + 2], l.props[o + 3]];
  }
}
