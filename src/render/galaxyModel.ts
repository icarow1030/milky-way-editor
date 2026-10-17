/**
 * Deterministic, *approximate* Milky Way structure for the large-scale visual layer only.
 * Nothing produced here is presented as observational data.
 *
 * Parameters (kpc, galactocentric frame, Sun at azimuth 180 deg):
 *  - 4 logarithmic arms, pitch 12 deg, crossing the Sun's azimuth at R = 6.9 (Sagittarius–Carina),
 *    9.6 (Perseus), 13.4 (Outer/Norma–Cygnus) and 4.9 (Scutum–Centaurus) kpc — roughly
 *    consistent with Reid et al. (2019) maser parallaxes at the Sun's azimuth.
 *  - Local (Orion) spur at R ≈ 8.3 kpc near the Sun.
 *  - Bar: half-length ~4.5 kpc, near end at positive longitude (angle ~27 deg from Sun–GC line).
 *  - Exponential disk, scale length 2.6 kpc; thin-disk scale height 0.3 kpc; young arms 0.1 kpc.
 *  - Arms trail the rotation (Galaxy rotates clockwise seen from the NGP, +z).
 */

export const GALAXY = {
  armPitchDeg: 12,
  armRefR: 6.9,
  armCount: 4,
  barAngleDeg: 153, // azimuth of the bar's near end (Sun at 180)
  diskScaleLength: 2.6,
  diskScaleHeight: 0.3,
  armScaleHeight: 0.1,
  rMax: 16,
} as const;

const TAN_P = Math.tan((GALAXY.armPitchDeg * Math.PI) / 180);

/** 0..1, peaks on arm centre lines. r in kpc, phi in radians. */
export function armStrength(r: number, phi: number): number {
  if (r < 0.5) return 0;
  const psi = phi - Math.log(r / GALAXY.armRefR) / TAN_P - Math.PI;
  const c = 0.5 + 0.5 * Math.cos(GALAXY.armCount * psi);
  // which arm: 1, 3 = Scutum–Centaurus, Perseus (major); 0, 2 = Sagittarius, Outer (minor)
  const k = ((Math.round((GALAXY.armCount * psi) / (2 * Math.PI)) % 4) + 4) % 4;
  const major = k === 1 || k === 3 ? 1 : 0.55;
  // slow deterministic variation along the arms (avoids a perfectly regular pinwheel)
  const along = 0.7 + 0.3 * Math.sin(2.3 * Math.log(r) * 4 + k * 1.7 + 1.3) * Math.sin(1.1 * phi + k);
  let s = Math.pow(c, 5) * major * along;
  // Local spur: short segment around the Sun's azimuth.
  const rLocal = 8.3 * Math.exp(Math.tan((11 * Math.PI) / 180) * (phi - Math.PI));
  const dphi = Math.atan2(Math.sin(phi - Math.PI * 1.03), Math.cos(phi - Math.PI * 1.03));
  s = Math.max(s, 0.6 * Math.exp(-((r - rLocal) ** 2) / (2 * 0.25 ** 2)) * Math.exp(-(dphi ** 2) / (2 * 0.22 ** 2)));
  // Arms fade in past the bar ends and fade out in the outer disk.
  const inner = smooth(3.0, 4.5, r);
  const outer = 1 - smooth(13, 16, r);
  return s * inner * outer;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Small, fast deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GalaxyPoints {
  positions: Float32Array; // pc, galactocentric
  colors: Uint8Array; // r, g, b, weight
  count: number;
}

/** Generates `count` aggregate points (each stands for many unresolved stars). Pure & deterministic. */
export function generateGalaxy(count: number, seed = 0x5eed): GalaxyPoints {
  const rnd = mulberry32(seed);
  const gauss = () => {
    const u = Math.max(rnd(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const laplace = (h: number) => (rnd() < 0.5 ? -1 : 1) * -h * Math.log(Math.max(rnd(), 1e-12));
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const barA = (GALAXY.barAngleDeg * Math.PI) / 180;
  const cb = Math.cos(barA), sb = Math.sin(barA);

  for (let i = 0; i < count; i++) {
    const u = rnd();
    let x: number, y: number, z: number, col: [number, number, number], w: number;
    if (u < 0.07) {
      // bulge (boxy, slightly flattened)
      x = gauss() * 0.8; y = gauss() * 0.8; z = gauss() * 0.5;
      col = [255, 206, 156]; w = 0.4;
    } else if (u < 0.17) {
      // bar
      const a = gauss() * 1.9, b = gauss() * 0.55;
      x = a * cb - b * sb; y = a * sb + b * cb; z = gauss() * 0.3;
      col = [255, 214, 165]; w = 0.42;
    } else if (u < 0.72) {
      // old thin disk, modulated by the arms (rejection sampling)
      let r: number, phi: number;
      do {
        r = -GALAXY.diskScaleLength * Math.log(Math.max(rnd() * rnd(), 1e-12));
        phi = rnd() * 2 * Math.PI;
      } while (r > GALAXY.rMax || r < 0.8 || rnd() > 0.25 + 0.75 * armStrength(r, phi));
      x = r * Math.cos(phi); y = r * Math.sin(phi); z = laplace(GALAXY.diskScaleHeight);
      col = [255, 233, 205]; w = 0.3;
    } else if (u < 0.96) {
      // young arm population
      let r: number, phi: number;
      do {
        r = 3 + rnd() * 12.5;
        phi = rnd() * 2 * Math.PI;
      } while (rnd() > armStrength(r, phi) * Math.exp(-(r - 3) / 6));
      x = r * Math.cos(phi) + gauss() * 0.12; y = r * Math.sin(phi) + gauss() * 0.12;
      z = laplace(GALAXY.armScaleHeight);
      col = rnd() < 0.85 ? [178, 202, 255] : [214, 226, 255]; w = 0.55;
    } else {
      // thick disk
      const r = -3.0 * Math.log(Math.max(rnd() * rnd(), 1e-12));
      const phi = rnd() * 2 * Math.PI;
      x = Math.min(r, 18) * Math.cos(phi); y = Math.min(r, 18) * Math.sin(phi); z = laplace(0.9);
      col = [255, 225, 190]; w = 0.25;
    }
    positions[i * 3] = x * 1000;
    positions[i * 3 + 1] = y * 1000;
    positions[i * 3 + 2] = z * 1000;
    colors[i * 4] = col[0]; colors[i * 4 + 1] = col[1]; colors[i * 4 + 2] = col[2];
    colors[i * 4 + 3] = Math.round(w * 255);
  }
  return { positions, colors, count };
}

/** GLSL version of armStrength (kept in sync with the TS above), r in kpc. */
export const ARM_GLSL = /* glsl */ `
float smoothR(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float armStrength(float r, float phi) {
  if (r < 0.5) return 0.0;
  const float PI = 3.14159265;
  float psi = phi - log(r / ${GALAXY.armRefR.toFixed(2)}) / ${TAN_P.toFixed(6)} - PI;
  float c = 0.5 + 0.5 * cos(${GALAXY.armCount.toFixed(1)} * psi);
  float k = mod(floor(${GALAXY.armCount.toFixed(1)} * psi / 6.2831853 + 0.5), 4.0);
  float major = (k == 1.0 || k == 3.0) ? 1.0 : 0.55;
  float along = 0.7 + 0.3 * sin(2.3 * log(r) * 4.0 + k * 1.7 + 1.3) * sin(1.1 * phi + k);
  float s = pow(c, 5.0) * major * along;
  float rLocal = 8.3 * exp(0.194380 * (phi - PI));
  float d = phi - PI * 1.03; float dphi = atan(sin(d), cos(d));
  s = max(s, 0.6 * exp(-pow(r - rLocal, 2.0) / (2.0 * 0.0625)) * exp(-dphi * dphi / (2.0 * 0.0484)));
  return s * smoothR(3.0, 4.5, r) * (1.0 - smoothR(13.0, 16.0, r));
}
`;
