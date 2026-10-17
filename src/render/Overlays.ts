import * as THREE from 'three';
import { SUN_GC, type Vec3 } from '../core/coords.ts';

/** Reference grids: galactocentric rings/spokes (kpc) and Sun-centred distance rings (pc). */
export class Grids {
  readonly group = new THREE.Group();
  private galactic: THREE.LineSegments;
  private galMat: THREE.LineBasicMaterial;
  private local: Array<{ line: THREE.LineLoop; mat: THREE.LineBasicMaterial; r: number }> = [];
  private localGroup = new THREE.Group();

  constructor() {
    const pts: number[] = [];
    const seg = 192;
    for (let r = 2000; r <= 16000; r += 2000) {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        pts.push(r * Math.cos(a0), r * Math.sin(a0), 0, r * Math.cos(a1), r * Math.sin(a1), 0);
      }
    }
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      pts.push(1000 * Math.cos(a), 1000 * Math.sin(a), 0, 16000 * Math.cos(a), 16000 * Math.sin(a), 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.galMat = new THREE.LineBasicMaterial({ color: 0x5a6a80, transparent: true, opacity: 0.25, depthTest: false, depthWrite: false });
    this.galactic = new THREE.LineSegments(g, this.galMat);
    this.galactic.frustumCulled = false;
    this.group.add(this.galactic);

    // Sun-centred rings in the Galactic plane (heliocentric b = 0 is ~ the world xy plane; tilt < 0.15 deg)
    for (const r of [1, 10, 100, 1000]) {
      const p: number[] = [];
      for (let i = 0; i < 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        p.push(r * Math.cos(a), r * Math.sin(a), 0);
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      const mat = new THREE.LineBasicMaterial({ color: 0x6f8fb0, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
      const line = new THREE.LineLoop(gg, mat);
      line.frustumCulled = false;
      this.localGroup.add(line);
      this.local.push({ line, mat, r });
    }
    this.group.add(this.localGroup);
  }

  update(cam: Vec3, viewDist: number): void {
    this.galactic.position.set(-cam[0], -cam[1], -cam[2]);
    this.galMat.opacity = 0.22 * smooth(1500, 6000, viewDist);
    this.localGroup.position.set(SUN_GC[0] - cam[0], SUN_GC[1] - cam[1], SUN_GC[2] - cam[2]);
    for (const l of this.local) {
      const x = l.r / viewDist; // ring size relative to the view
      l.mat.opacity = 0.35 * smooth(0.04, 0.15, x) * (1 - smooth(1.5, 3, x));
    }
  }

  /** Labels for the visible Sun-centred rings: [radius pc, opacity]. */
  ringLabels(viewDist: number): Array<[number, number]> {
    return this.local.map((l) => [l.r, l.mat.opacity] as [number, number]).filter(([, o]) => o > 0.05 && viewDist > 0);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Pooled absolutely-positioned HTML labels drawn over the canvas. */
export class LabelLayer {
  private pool: HTMLDivElement[] = [];
  private used = 0;
  constructor(private root: HTMLElement) {}

  begin(): void {
    this.used = 0;
  }

  add(x: number, y: number, text: string, cls: string): void {
    let el = this.pool[this.used];
    if (!el) {
      el = document.createElement('div');
      this.root.appendChild(el);
      this.pool.push(el);
    }
    this.used++;
    if (el.textContent !== text) el.textContent = text;
    if (el.className !== `lbl ${cls}`) el.className = `lbl ${cls}`;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    el.style.display = '';
  }

  end(): void {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }
}
