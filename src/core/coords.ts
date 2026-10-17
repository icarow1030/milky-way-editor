/**
 * Coordinate systems and transforms. Shared by the import pipeline (Node) and the app.
 * All math is in float64 (JS numbers); only camera-relative vectors go to the GPU as float32.
 *
 * Frames (see docs/COORDINATES.md):
 *  - ICRS equatorial: (ra, dec) in degrees, distance in parsecs.
 *  - Heliocentric equatorial cartesian (pc): +x -> (ra=0,dec=0), +z -> north celestial pole.
 *  - Heliocentric galactic cartesian (pc):  +X -> galactic centre (l=0,b=0), +Y -> l=90 deg
 *    (direction of Galactic rotation), +Z -> north galactic pole. IAU 1958 / Hipparcos matrix.
 *  - Galactocentric (pc), astropy v4.0 convention: origin at Sgr A*, +x from the Sun's
 *    projection towards the GC, +y towards l=90, +z towards the NGP. Sun at
 *    (-R0*cos(theta), 0, +z_sun), theta = asin(z_sun/R0). This is the app's WORLD frame.
 *  - Render frame: world coordinates minus the camera position (float64 subtraction),
 *    so the camera is always at the origin (floating origin / relative-to-eye).
 */

export type Vec3 = [number, number, number];

export const DEG = Math.PI / 180;
export const PC_PER_LY = 0.306601393788;
export const LY_PER_PC = 3.261563777167433;
export const AU_PER_PC = 206264.80624709636;

/** Galactocentric frame parameters (astropy v4.0 defaults). */
export const GALCEN = {
  /** ICRS position of Sgr A* (Reid & Brunthaler 2004), degrees. */
  ra: 266.4051,
  dec: -28.936175,
  /** Sun–GC distance, pc (GRAVITY Collaboration 2018). */
  distance: 8122.0,
  /** Height of the Sun above the Galactic midplane, pc (Bennett & Bovy 2019). */
  zSun: 20.8,
  /** astropy "roll0": aligns the frame with the Galactic coordinate system. */
  roll0Deg: 58.5986320306,
} as const;

/** ICRS -> Galactic rotation matrix (Hipparcos, ESA 1997, Vol. 1 §1.5.3), row-major. */
export const ICRS_TO_GAL: readonly number[] = [
  -0.0548755604162154, -0.873437090234885, -0.4838350155487132,
  0.4941094278755837, -0.4448296299600112, 0.7469822444972189,
  -0.8676661490190047, -0.1980763734312015, 0.4559837761750669,
];

type Mat3 = number[]; // row-major 3x3

function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}
function apply(m: readonly number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
function transpose(m: readonly number[]): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Passive (frame) rotation matrices, same convention as astropy's rotation_matrix. */
function rot(angleRad: number, axis: 'x' | 'y' | 'z'): Mat3 {
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  if (axis === 'x') return [1, 0, 0, 0, c, s, 0, -s, c];
  if (axis === 'y') return [c, 0, -s, 0, 1, 0, s, 0, c];
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

// ICRS -> galactocentric: x_gc = H * (R * x_icrs - d * x_hat)
const R_GC = mul(rot(GALCEN.roll0Deg * DEG, 'x'), mul(rot(-GALCEN.dec * DEG, 'y'), rot(GALCEN.ra * DEG, 'z')));
const THETA = Math.asin(GALCEN.zSun / GALCEN.distance);
const H_GC = rot(-THETA, 'y');
const ICRS_TO_GC = mul(H_GC, R_GC);
const GC_TO_ICRS = transpose(ICRS_TO_GC);
const GC_OFFSET: Vec3 = apply(H_GC, [-GALCEN.distance, 0, 0]);
const GAL_TO_ICRS = transpose(ICRS_TO_GAL);

/** Position of the Sun in the galactocentric (world) frame, pc. */
export const SUN_GC: Vec3 = [...GC_OFFSET] as Vec3;

/** (ra, dec, dist) -> heliocentric equatorial cartesian. Degrees, pc. */
export function equatorialToCartesian(raDeg: number, decDeg: number, dist: number): Vec3 {
  const ra = raDeg * DEG, dec = decDeg * DEG;
  const cd = Math.cos(dec);
  return [dist * cd * Math.cos(ra), dist * cd * Math.sin(ra), dist * Math.sin(dec)];
}

/** Heliocentric equatorial cartesian -> (ra [0,360), dec, dist). */
export function cartesianToEquatorial(v: Vec3): { ra: number; dec: number; dist: number } {
  const dist = Math.hypot(v[0], v[1], v[2]);
  let ra = Math.atan2(v[1], v[0]) / DEG;
  if (ra < 0) ra += 360;
  const dec = dist > 0 ? Math.asin(v[2] / dist) / DEG : 0;
  return { ra, dec, dist };
}

export const equatorialToGalacticCartesian = (v: Vec3): Vec3 => apply(ICRS_TO_GAL, v);
export const galacticCartesianToEquatorial = (v: Vec3): Vec3 => apply(GAL_TO_ICRS, v);

/** Heliocentric galactic cartesian -> (l [0,360), b, dist). */
export function cartesianToGalactic(v: Vec3): { l: number; b: number; dist: number } {
  const s = cartesianToEquatorial(v); // same spherical math, different axes
  return { l: s.ra, b: s.dec, dist: s.dist };
}

export function galacticToCartesian(lDeg: number, bDeg: number, dist: number): Vec3 {
  return equatorialToCartesian(lDeg, bDeg, dist);
}

/** Heliocentric equatorial cartesian (pc) -> galactocentric world (pc). */
export function equatorialToGalactocentric(v: Vec3): Vec3 {
  const r = apply(ICRS_TO_GC, v);
  return [r[0] + GC_OFFSET[0], r[1] + GC_OFFSET[1], r[2] + GC_OFFSET[2]];
}

/** Galactocentric world (pc) -> heliocentric equatorial cartesian (pc). */
export function galactocentricToEquatorial(w: Vec3): Vec3 {
  return apply(GC_TO_ICRS, [w[0] - GC_OFFSET[0], w[1] - GC_OFFSET[1], w[2] - GC_OFFSET[2]]);
}

/** Convenience: ICRS (ra, dec, dist) -> galactocentric world. */
export function radecToWorld(raDeg: number, decDeg: number, dist: number): Vec3 {
  return equatorialToGalactocentric(equatorialToCartesian(raDeg, decDeg, dist));
}

/** World -> galactic (l, b) and distance as seen from the Sun. */
export function worldToGalactic(w: Vec3): { l: number; b: number; dist: number } {
  return cartesianToGalactic(equatorialToGalacticCartesian(galactocentricToEquatorial(w)));
}

/** World -> ICRS (ra, dec) and distance as seen from the Sun. */
export function worldToEquatorial(w: Vec3): { ra: number; dec: number; dist: number } {
  return cartesianToEquatorial(galactocentricToEquatorial(w));
}

/** Render-frame (camera-relative) vector. Subtraction in float64 before narrowing to float32. */
export function toRender(w: Vec3, cam: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = w[0] - cam[0];
  out[1] = w[1] - cam[1];
  out[2] = w[2] - cam[2];
  return out;
}

/** Galactocentric cylindrical radius and azimuth (deg, Sun at 180). */
export function worldToCylindrical(w: Vec3): { R: number; phi: number; z: number } {
  let phi = Math.atan2(w[1], w[0]) / DEG;
  if (phi < 0) phi += 360;
  return { R: Math.hypot(w[0], w[1]), phi, z: w[2] };
}

/** Sexagesimal formatting helpers for the UI. */
export function formatRA(raDeg: number): string {
  const h = (((raDeg % 360) + 360) % 360) / 15;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  const ss = ((h - hh) * 60 - mm) * 60;
  return `${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m ${ss.toFixed(2).padStart(5, '0')}s`;
}
export function formatDec(decDeg: number): string {
  const sign = decDeg < 0 ? '−' : '+';
  const a = Math.abs(decDeg);
  const dd = Math.floor(a);
  const mm = Math.floor((a - dd) * 60);
  const ss = ((a - dd) * 60 - mm) * 60;
  return `${sign}${String(dd).padStart(2, '0')}° ${String(mm).padStart(2, '0')}′ ${ss.toFixed(1).padStart(4, '0')}″`;
}

/** Human-readable distance: AU, pc, kpc, with light-years. */
export function formatDistance(pc: number): string {
  if (!isFinite(pc)) return '—';
  if (pc < 0.05) return `${(pc * AU_PER_PC).toPrecision(3)} AU`;
  const ly = pc * LY_PER_PC;
  const lyStr = ly >= 1000 ? `${(ly / 1000).toFixed(ly >= 1e4 ? 1 : 2)} kly` : `${ly.toPrecision(3)} ly`;
  if (pc >= 1000) return `${(pc / 1000).toFixed(pc >= 1e4 ? 1 : 2)} kpc · ${lyStr}`;
  return `${pc.toPrecision(pc < 10 ? 3 : 4)} pc · ${lyStr}`;
}
