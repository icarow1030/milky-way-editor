/**
 * Spectral and luminosity classes: parsing catalogued types (HYG strings such as "K1III",
 * "A0m...", "DA2", "sdB5") and *estimating* them from photometry when no type is catalogued.
 *
 * Estimates are deliberately coarse and always flagged as such:
 *  - class from T_eff, itself from Gaia BP−RP (no reddening correction: dusty sightlines look cooler);
 *  - luminosity class from the offset to an approximate Gaia main sequence in (BP−RP, M_G),
 *    skipped when the astrometry is poor (RUWE > 1.4), since the distance then is unreliable.
 *
 * Per-star props (4 bytes, part of the render payload): [class, luminosity, colorQ, flags].
 */
import { tempFromBpRp } from './photometry.ts';

export const SpecClass = { Unknown: 0, O: 1, B: 2, A: 3, F: 4, G: 5, K: 6, M: 7, LT: 8, WD: 9, Carbon: 10 } as const;
export const LumClass = { Unknown: 0, I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, WD: 7 } as const;

export const CLASS_LABELS = ['?', 'O', 'B', 'A', 'F', 'G', 'K', 'M', 'L/T', 'D', 'C/S'];
export const CLASS_TITLES = [
  'sem cor', 'O · > 30 000 K', 'B · 10 000–30 000 K', 'A · 7 500–10 000 K', 'F · 6 000–7 500 K',
  'G · 5 200–6 000 K', 'K · 3 700–5 200 K', 'M · < 3 700 K', 'anãs marrons', 'anãs brancas', 'carbono / S',
];
export const LUM_LABELS = ['?', 'I', 'II', 'III', 'IV', 'V', 'VI', 'D'];
export const LUM_TITLES = [
  'indeterminada', 'supergigantes', 'gigantes brilhantes', 'gigantes', 'subgigantes', 'anãs (sequência principal)',
  'subanãs', 'anãs brancas',
];

export const PropFlag = {
  ClassEstimated: 1, // class not catalogued: estimated from colour
  LumEstimated: 2, // luminosity class not catalogued: estimated from the HR diagram
  ColorConverted: 4, // BP−RP converted from Johnson B−V (HYG), not measured by Gaia
} as const;

/** BP−RP packed into one byte: [-0.6, 5.75] in 0.025 steps; 255 = unknown. */
export const COLOR_MIN = -0.6;
export const COLOR_STEP = 0.025;
export const COLOR_UNKNOWN = 255;
export function packColor(c: number): number {
  if (!isFinite(c)) return COLOR_UNKNOWN;
  return Math.min(254, Math.max(0, Math.round((c - COLOR_MIN) / COLOR_STEP)));
}
export function unpackColor(q: number): number {
  return q === COLOR_UNKNOWN ? NaN : COLOR_MIN + q * COLOR_STEP;
}

const LETTER: Record<string, number> = { O: 1, B: 2, A: 3, F: 4, G: 5, K: 6, M: 7, L: 8, T: 8, Y: 8, W: 1, C: 10, R: 10, N: 10, S: 10 };

/** Parses a catalogued spectral type. Returns zeros for what the string does not state. */
export function parseSpectralType(raw: string | undefined | null): { cls: number; lum: number } {
  const s = (raw ?? '').trim();
  if (!s) return { cls: 0, lum: 0 };
  if (/^D[ABOQZCX]?/.test(s) && !/^D[a-z]/.test(s)) return { cls: SpecClass.WD, lum: LumClass.WD };
  let lum = 0;
  let rest = s;
  // Mount Wilson style prefixes: sd = subdwarf, d = dwarf, g = giant, c = supergiant
  const pre = /^(sd|d|g|c)(?=[OBAFGKM])/.exec(rest);
  if (pre) {
    lum = { sd: LumClass.VI, d: LumClass.V, g: LumClass.III, c: LumClass.I }[pre[1]]!;
    rest = rest.slice(pre[1].length);
  }
  const m = /[OBAFGKMLTYWCRNS]/.exec(rest);
  if (!m) return { cls: 0, lum };
  const cls = LETTER[m[0]];
  const tail = rest.slice(m.index + 1);
  if (!lum) {
    const l = /(VI|V|IV|III|II|I)/.exec(tail);
    if (l) lum = { VI: 6, V: 5, IV: 4, III: 3, II: 2, I: 1 }[l[1]]!;
  }
  return { cls, lum };
}

export function classFromTemp(t: number): number {
  if (!isFinite(t)) return 0;
  if (t >= 30000) return SpecClass.O;
  if (t >= 10000) return SpecClass.B;
  if (t >= 7500) return SpecClass.A;
  if (t >= 6000) return SpecClass.F;
  if (t >= 5200) return SpecClass.G;
  if (t >= 3700) return SpecClass.K;
  if (t >= 2300) return SpecClass.M;
  return SpecClass.LT;
}

/** Approximate Gaia main sequence: M_G as a function of BP−RP (piecewise linear). */
const MS: Array<[number, number]> = [
  [-0.4, -2.5], [-0.2, -0.5], [0.0, 1.0], [0.4, 3.0], [0.82, 4.67], [1.2, 6.3], [1.8, 8.8], [2.5, 10.6],
  [3.0, 12.0], [4.0, 14.5], [5.0, 16.5],
];
export function mainSequenceMG(c: number): number {
  if (c <= MS[0][0]) return MS[0][1];
  for (let i = 1; i < MS.length; i++) {
    if (c <= MS[i][0]) {
      const [x0, y0] = MS[i - 1], [x1, y1] = MS[i];
      return y0 + ((c - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return MS[MS.length - 1][1];
}

/** Luminosity class from the vertical offset to the main sequence in the HR diagram. */
export function estimateFromPhotometry(bpRp: number, absMag: number): { cls: number; lum: number } {
  if (!isFinite(bpRp) || !isFinite(absMag)) return { cls: 0, lum: 0 };
  const d = absMag - mainSequenceMG(bpRp); // > 0: fainter than the MS, < 0: brighter
  if (d > 4.5 && absMag > 9 && bpRp < 1.6) return { cls: SpecClass.WD, lum: LumClass.WD };
  const cls = classFromTemp(tempFromBpRp(bpRp));
  let lum: number;
  if (d > 1.5) lum = LumClass.VI;
  else if (d >= -1.0) lum = LumClass.V;
  else if (d >= -2.5) lum = LumClass.IV;
  else if (absMag > -3.0) lum = LumClass.III;
  else if (absMag > -5.0) lum = LumClass.II;
  else lum = LumClass.I;
  return { cls, lum };
}

/** Inverse of tempFromBpRp (Mucciarelli & Bellazzini 2020 relation). */
export function bpRpFromTemp(t: number): number {
  const theta = 5040 / t;
  const a = -0.0353, b = 0.5092, c0 = 0.4929 - theta;
  const disc = b * b - 4 * a * c0;
  if (disc < 0) return 4.5;
  return Math.min(4.5, Math.max(-0.5, (-b + Math.sqrt(disc)) / (2 * a)));
}

/** Combines catalogued type (if any) with photometric estimates into the 4 prop bytes. */
export function encodeProps(spect: string | undefined, bpRp: number, absMag: number, colorConverted: boolean,
  poorAstrometry = false): [number, number, number, number] {
  const cat = parseSpectralType(spect);
  // With poor astrometry (Gaia RUWE > 1.4) the HR-diagram position is unreliable: class from colour only.
  const est = poorAstrometry
    ? { cls: classFromTemp(isFinite(bpRp) ? tempFromBpRp(bpRp) : NaN), lum: 0 }
    : estimateFromPhotometry(bpRp, absMag);
  let flags = colorConverted ? PropFlag.ColorConverted : 0;
  let cls = cat.cls, lum = cat.lum;
  if (!cls) { cls = est.cls; if (cls) flags |= PropFlag.ClassEstimated; }
  if (!lum) {
    lum = cls === SpecClass.WD && cat.cls === SpecClass.WD ? LumClass.WD : est.lum;
    if (lum) flags |= PropFlag.LumEstimated;
  }
  return [cls, lum, packColor(bpRp), flags];
}

export function describeType(cls: number, lum: number): string {
  if (cls === SpecClass.WD) return 'D (anã branca)';
  return `${CLASS_LABELS[cls] ?? '?'}${lum && lum !== LumClass.WD ? ' ' + LUM_LABELS[lum] : ''}`;
}
