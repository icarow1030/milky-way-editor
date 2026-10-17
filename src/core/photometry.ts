/**
 * Approximate stellar colours and magnitude packing. These are *display* approximations:
 * no interstellar extinction/reddening correction is applied.
 */

/** Effective temperature from Johnson B−V (Ballesteros 2012). */
export function tempFromBV(bv: number): number {
  const c = Math.min(Math.max(bv, -0.4), 2.0);
  return 4600 * (1 / (0.92 * c + 1.7) + 1 / (0.92 * c + 0.62));
}

/** Effective temperature from Gaia BP−RP (Mucciarelli & Bellazzini 2020, dwarfs; extrapolated outside 0.39–1.5). */
export function tempFromBpRp(c: number): number {
  const x = Math.min(Math.max(c, -0.5), 4.5);
  return 5040 / (0.4929 + 0.5092 * x - 0.0353 * x * x);
}

/** Approximate sRGB (0..1) of a blackbody, desaturated slightly: stars look less vivid than Planck curves suggest. */
export function rgbFromTemp(tempK: number): [number, number, number] {
  const t = Math.min(Math.max(tempK, 1500), 40000) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v: number) => Math.min(Math.max(v, 0), 255) / 255;
  const rgb: [number, number, number] = [c(r), c(g), c(b)];
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const sat = 0.75;
  return rgb.map((v) => lum + (v - lum) * sat).map((v) => Math.min(1, v / Math.max(...rgb))) as [number, number, number];
}

/** Absolute magnitude packed into one byte: M in [-12, 19.875], 0.125 mag steps. */
export const ABSMAG_MIN = -12;
export const ABSMAG_STEP = 0.125;
export function packAbsMag(m: number): number {
  return Math.min(255, Math.max(0, Math.round((m - ABSMAG_MIN) / ABSMAG_STEP)));
}
export function unpackAbsMag(q: number): number {
  return ABSMAG_MIN + q * ABSMAG_STEP;
}

/** Distance modulus. */
export function absoluteMagnitude(apparent: number, distPc: number): number {
  return apparent - 5 * Math.log10(distPc / 10);
}
