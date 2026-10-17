import * as THREE from 'three';
import { ARM_GLSL, type GalaxyPoints } from './galaxyModel.ts';
import type { Vec3 } from '../core/coords.ts';

/**
 * Procedural, deterministic large-scale Milky Way: aggregate points + a smooth disk glow.
 * Visual only — not pickable, and faded out close to the camera so that, near the Sun,
 * the observational catalog is what you see.
 */
export class GalaxyLayer {
  readonly group = new THREE.Group();
  private points: THREE.Points | null = null;
  private disk: THREE.Mesh;
  private pointMat: THREE.ShaderMaterial;
  private diskMat: THREE.ShaderMaterial;
  count = 0;
  gpuBytes = 0;
  ready: Promise<void>;

  constructor(count = 400_000, seed = 0x5eed) {
    this.pointMat = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: 1 }, uIntensity: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec4 rgbw;
        uniform float uPixelRatio;
        uniform float uIntensity;
        varying vec4 vC;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = length(mv.xyz);
          // fade out near the camera (catalog takes over), and soften very distant clumps
          float fade = smoothstep(120.0, 700.0, d);
          vC = vec4(rgbw.rgb, rgbw.a * fade * uIntensity);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (fade > 0.0 ? 1.6 : 0.0) * uPixelRatio;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vC;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float a = max(0.0, 1.0 - dot(p, p));
          gl_FragColor = vec4(vC.rgb * vC.a * a * 0.42, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });

    // Disk glow: one quad in the galactic plane, density evaluated per fragment.
    this.diskMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec2 vXY;
        void main() {
          vXY = position.xy; // kpc (geometry is built in kpc and scaled to pc by the mesh)
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying vec2 vXY;
        ${ARM_GLSL}
        void main() {
          float r = length(vXY);
          float phi = atan(vXY.y, vXY.x);
          if (phi < 0.0) phi += 6.2831853;
          float bulge = exp(-r * r / (2.0 * 0.9 * 0.9));
          // bar (rotated ellipse)
          float ba = radians(153.0);
          vec2 q = vec2(cos(ba) * vXY.x + sin(ba) * vXY.y, -sin(ba) * vXY.x + cos(ba) * vXY.y);
          float bar = exp(-(q.x * q.x) / (2.0 * 2.0 * 2.0) - (q.y * q.y) / (2.0 * 0.6 * 0.6));
          float disk = exp(-r / 2.6) * (1.0 - smoothR(14.0, 17.0, r)) * smoothR(0.0, 2.5, r);
          float arms = armStrength(r, phi);
          vec3 col = vec3(1.0, 0.8, 0.58) * (0.9 * bulge + 0.6 * bar)
                   + vec3(1.0, 0.9, 0.8) * disk * (0.35 + 0.3 * arms)
                   + vec3(0.62, 0.72, 1.0) * disk * arms * 0.9;
          gl_FragColor = vec4(col * 0.45 * uOpacity, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
    });
    const g = new THREE.PlaneGeometry(36, 36, 1, 1);
    this.disk = new THREE.Mesh(g, this.diskMat);
    this.disk.scale.setScalar(1000);
    this.disk.frustumCulled = false;
    this.group.add(this.disk);

    this.ready = new Promise((resolve) => {
      const worker = new Worker(new URL('./galaxy.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<GalaxyPoints>) => {
        this.build(e.data);
        worker.terminate();
        resolve();
      };
      worker.postMessage({ count, seed });
    });
  }

  private build(g: GalaxyPoints): void {
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(g.positions, 3);
    const col = new THREE.BufferAttribute(g.colors, 4, true);
    // Not pickable, so the CPU copies are released right after upload (GPU holds the only copy).
    const release = function (this: THREE.BufferAttribute) {
      (this as unknown as { array: null }).array = null;
    };
    pos.onUpload(release);
    col.onUpload(release);
    geo.setAttribute('position', pos);
    geo.setAttribute('rgbw', col);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30000);
    this.points = new THREE.Points(geo, this.pointMat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.count = g.count;
    this.gpuBytes = g.positions.byteLength + g.colors.byteLength;
  }

  /** cam: camera world position (float64). viewDist: orbit distance (pc). */
  update(cam: Vec3, pixelRatio: number, viewDist: number): void {
    this.group.position.set(-cam[0], -cam[1], -cam[2]);
    this.pointMat.uniforms.uPixelRatio.value = pixelRatio;
    // Points get slightly stronger when the whole galaxy is in view.
    // Inside the disk the band should read as a faint glow behind the real stars.
    this.pointMat.uniforms.uIntensity.value = 0.3 + 0.5 * smooth(300, 6000, viewDist) + 0.4 * smooth(6000, 30000, viewDist);
    // Disk glow: hidden when the camera is inside the disk layer or sees it edge-on.
    const h = Math.abs(cam[2]);
    const r = Math.hypot(cam[0], cam[1], cam[2]);
    const faceOn = r > 0 ? h / r : 0;
    this.diskMat.uniforms.uOpacity.value = smooth(400, 4000, h) * smooth(0.05, 0.35, faceOn);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}
