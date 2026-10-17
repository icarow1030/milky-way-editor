import * as THREE from 'three';
import type { Vec3 } from '../core/coords.ts';

/**
 * Orbit-around-focus camera with logarithmic zoom and free flight, all state in float64.
 * The THREE camera itself always stays at the origin (floating origin); only its rotation
 * is set here. `position` is the true world position (galactocentric, pc).
 *
 *  left drag: orbit · right/middle drag or shift+drag: pan · wheel: zoom (log)
 *  W/A/S/D: fly · R/F: up/down · Shift: ×5 speed
 */
export interface ViewState {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
}

const MIN_DIST = 2e-6; // pc (~0.4 AU)
const MAX_DIST = 2.5e5; // pc

export class CameraController {
  // current (smoothed) and goal state
  target: Vec3 = [0, 0, 0];
  distance = 1;
  yaw = 0;
  pitch = 0.3;
  private goal: ViewState = { target: [0, 0, 0], distance: 1, yaw: 0, pitch: 0.3 };
  private flight: { from: ViewState; to: ViewState; t: number; dur: number; hump: number } | null = null;
  readonly position: Vec3 = [0, 0, 0];
  private keys = new Set<string>();
  private drag: { x: number; y: number; mode: 'orbit' | 'pan'; moved: number } | null = null;
  onClick: (x: number, y: number) => void = () => {};
  onDoubleClick: (x: number, y: number) => void = () => {};
  onUserMove: () => void = () => {};

  constructor(private camera: THREE.PerspectiveCamera, private el: HTMLElement) {
    camera.up.set(0, 0, 1);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const pan = e.button === 2 || e.button === 1 || e.shiftKey;
      this.drag = { x: e.clientX, y: e.clientY, mode: pan ? 'pan' : 'orbit', moved: 0 };
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      if (this.drag.moved < 3) return;
      this.cancelFlight();
      if (this.drag.mode === 'orbit') {
        this.goal.yaw -= dx * 0.005;
        this.goal.pitch = clamp(this.goal.pitch + dy * 0.005, -1.55, 1.55);
      } else {
        this.panBy(dx, dy);
      }
      this.onUserMove();
    });
    el.addEventListener('pointerup', (e) => {
      if (this.drag && this.drag.moved < 3 && e.button === 0) this.onClick(e.offsetX, e.offsetY);
      this.drag = null;
    });
    el.addEventListener('dblclick', (e) => this.onDoubleClick(e.offsetX, e.offsetY));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cancelFlight();
      const k = e.deltaMode === 1 ? 0.05 : 0.0015;
      this.goal.distance = clamp(this.goal.distance * Math.exp(e.deltaY * k), MIN_DIST, MAX_DIST);
      this.onUserMove();
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
      this.keys.add(e.key.toLowerCase());
      if (e.key === 'Shift') this.keys.add('shift');
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
      if (e.key === 'Shift') this.keys.delete('shift');
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  private basis(yaw = this.yaw, pitch = this.pitch) {
    // direction from target to camera
    const back: Vec3 = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
    const right: Vec3 = [-Math.sin(yaw), Math.cos(yaw), 0];
    const up: Vec3 = [
      back[1] * right[2] - back[2] * right[1],
      back[2] * right[0] - back[0] * right[2],
      back[0] * right[1] - back[1] * right[0],
    ];
    return { back, right, up };
  }

  private panBy(dx: number, dy: number): void {
    const { right, up } = this.basis(this.goal.yaw, this.goal.pitch);
    const s = (2 * this.goal.distance * Math.tan((this.camera.fov * Math.PI) / 360)) / this.el.clientHeight;
    // dragging moves the scene with the cursor
    for (let i = 0; i < 3; i++) this.goal.target[i] += (-dx * right[i] + dy * up[i]) * s;
  }

  setState(s: ViewState, immediate = true): void {
    this.goal = { target: [...s.target] as Vec3, distance: s.distance, yaw: s.yaw, pitch: s.pitch };
    if (immediate) {
      this.target = [...s.target] as Vec3;
      this.distance = s.distance;
      this.yaw = s.yaw;
      this.pitch = s.pitch;
    }
  }

  getState(): ViewState {
    return { target: [...this.goal.target] as Vec3, distance: this.goal.distance, yaw: this.goal.yaw, pitch: this.goal.pitch };
  }

  /** Smooth flight to a new focus. Zooms out on the way when the jump is large relative to the view. */
  flyTo(target: Vec3, distance?: number, pitch?: number): void {
    const from: ViewState = { target: [...this.target] as Vec3, distance: this.distance, yaw: this.yaw, pitch: this.pitch };
    const to: ViewState = { target: [...target] as Vec3, distance: clamp(distance ?? this.distance, MIN_DIST, MAX_DIST), yaw: this.goal.yaw, pitch: pitch ?? this.goal.pitch };
    const jump = Math.hypot(target[0] - from.target[0], target[1] - from.target[1], target[2] - from.target[2]);
    const hump = Math.max(0, Math.log(jump / Math.max(from.distance, to.distance)) * 0.9);
    const zoom = Math.abs(Math.log(to.distance / from.distance));
    const dur = clamp(0.6 + 0.12 * (hump + zoom), 0.6, 2.4);
    this.flight = { from, to, t: 0, dur, hump };
    this.goal = { ...to, target: [...to.target] as Vec3 };
  }

  private cancelFlight(): void {
    if (!this.flight) return;
    this.flight = null;
    this.goal = { target: [...this.target] as Vec3, distance: this.distance, yaw: this.yaw, pitch: this.pitch };
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  update(dt: number): void {
    // keyboard flight: speed proportional to the view distance
    const k = this.keys;
    const fwd = (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0);
    const str = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
    const vert = (k.has('r') ? 1 : 0) - (k.has('f') ? 1 : 0);
    if (fwd || str || vert) {
      this.cancelFlight();
      const { back, right } = this.basis(this.goal.yaw, this.goal.pitch);
      const v = this.goal.distance * 0.8 * (k.has('shift') ? 5 : 1) * dt;
      for (let i = 0; i < 3; i++) this.goal.target[i] += (-back[i] * fwd + right[i] * str + (i === 2 ? vert : 0)) * v;
      this.onUserMove();
    }

    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.dur);
      const s = f.t * f.t * (3 - 2 * f.t);
      for (let i = 0; i < 3; i++) this.target[i] = f.from.target[i] + (f.to.target[i] - f.from.target[i]) * s;
      const ld = Math.log(f.from.distance) + (Math.log(f.to.distance) - Math.log(f.from.distance)) * s + f.hump * Math.sin(Math.PI * s);
      this.distance = Math.exp(ld);
      this.yaw = f.from.yaw + (f.to.yaw - f.from.yaw) * s;
      this.pitch = f.from.pitch + (f.to.pitch - f.from.pitch) * s;
      if (f.t >= 1) this.flight = null;
    } else {
      // exponential smoothing towards the goal (time constant ~90 ms)
      const a = 1 - Math.exp(-dt / 0.09);
      for (let i = 0; i < 3; i++) this.target[i] += (this.goal.target[i] - this.target[i]) * a;
      this.distance = Math.exp(Math.log(this.distance) + (Math.log(this.goal.distance) - Math.log(this.distance)) * a);
      const b = 1 - Math.exp(-dt / 0.07);
      this.yaw += (this.goal.yaw - this.yaw) * b;
      this.pitch += (this.goal.pitch - this.pitch) * b;
    }

    const { back } = this.basis();
    for (let i = 0; i < 3; i++) this.position[i] = this.target[i] + back[i] * this.distance;

    // floating origin: the GPU camera sits at 0,0,0 and looks at (target − position)
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(-back[0], -back[1], -back[2]);
    this.camera.near = Math.max(this.distance * 1e-3, 1e-9);
    this.camera.far = 1e7;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }
}

function clamp(v: number, a: number, b: number): number {
  return Math.min(Math.max(v, a), b);
}
