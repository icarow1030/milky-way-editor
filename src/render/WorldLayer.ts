import * as THREE from 'three';
import { radecToWorld, SUN_GC, type Vec3 } from '../core/coords.ts';
import { AUTHORIAL_COLOR, type Entity } from '../world/model.ts';
import type { WorldService } from '../world/WorldService.ts';

/**
 * Markers for stars annotated in the active world. Few (hundreds to thousands), so positions are
 * rewritten camera-relative every frame from float64 world coordinates: exact at any zoom, and
 * independent of which catalogue nodes are loaded (positions come from the anchor snapshot).
 */
export interface WorldMarker {
  entity: Entity;
  world: Vec3;
  color: string;
}

const VERT = /* glsl */ `
  attribute vec3 color;
  uniform float uPixelRatio;
  varying vec3 vColor;
  void main() {
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = 13.0 * uPixelRatio;
  }`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    float ring = smoothstep(0.62, 0.72, r) * (1.0 - smoothstep(0.86, 0.98, r));
    if (ring < 0.02) discard;
    gl_FragColor = vec4(vColor, ring * 0.9);
  }`;

export class WorldLayer {
  readonly group = new THREE.Group();
  markers: WorldMarker[] = [];
  private geo = new THREE.BufferGeometry();
  private points: THREE.Points;
  private pos = new Float32Array(0);
  private col = new Float32Array(0);
  private mat: THREE.ShaderMaterial;
  private svc: WorldService;

  constructor(svc: WorldService) {
    this.svc = svc;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: 1 } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.group.add(this.points);
    svc.on((e) => {
      if (e.type === 'active' || e.type === 'entities' || e.type === 'meta' || e.type === 'resolved') this.rebuild();
    });
  }

  private rebuild(): void {
    const tags = new Map(this.svc.active?.tags.map((t) => [t.id, t.color]) ?? []);
    this.markers = [];
    for (const e of this.svc.entities.values()) {
      const a = e.anchor;
      if (!a || !isFinite(a.ra) || !isFinite(a.dec) || !isFinite(a.dist)) continue;
      const world: Vec3 = a.dist > 0 ? radecToWorld(a.ra, a.dec, a.dist) : ([...SUN_GC] as Vec3);
      this.markers.push({ entity: e, world, color: tags.get(e.tags[0]) ?? AUTHORIAL_COLOR });
    }
    const n = this.markers.length;
    if (this.pos.length !== n * 3 || !this.geo.getAttribute('position')) {
      this.pos = new Float32Array(n * 3);
      this.col = new Float32Array(n * 3);
      this.geo.dispose();
      this.geo = new THREE.BufferGeometry();
      this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
      this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
      this.points.geometry = this.geo;
    }
    const c = new THREE.Color();
    this.markers.forEach((m, i) => {
      c.set(m.color);
      this.col.set([c.r, c.g, c.b], i * 3);
    });
    (this.geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  update(cam: Vec3, pixelRatio: number): void {
    this.mat.uniforms.uPixelRatio.value = pixelRatio;
    const p = this.pos;
    this.markers.forEach((m, i) => {
      p[i * 3] = m.world[0] - cam[0];
      p[i * 3 + 1] = m.world[1] - cam[1];
      p[i * 3 + 2] = m.world[2] - cam[2];
    });
    const attr = this.geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
    this.geo.setDrawRange(0, this.markers.length);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** Marker under the cursor (screen px), nearest first. */
  pick(px: number, py: number, project: (w: Vec3) => [number, number] | null): WorldMarker | null {
    if (!this.group.visible) return null;
    let best: WorldMarker | null = null, bestD = 9;
    for (const m of this.markers) {
      const s = project(m.world);
      if (!s) continue;
      const d = Math.hypot(s[0] - px, s[1] - py);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }
}
