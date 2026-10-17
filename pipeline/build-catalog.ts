/**
 * Builds the compact binary star catalog consumed by the app.
 *
 *   data-raw/hygdata_v41.csv + data-raw/gaia/chunk_*.csv
 *     -> merge (Gaia astrometry preferred; HYG names attached via Hipparcos cross-match)
 *     -> ICRS -> galactocentric world frame (float64)
 *     -> luminosity-ordered octree (brightest stars in shallow nodes = LOD)
 *     -> public/data/catalog/{index.json, nodes/*.bin, nodes/*.meta.bin, names.json}
 *
 * Flags:
 *   --sample   build from pipeline/sample/hyg-sample.csv only (a small, real HYG excerpt,
 *              for offline use). The resulting index is marked sample=true.
 *   --hyg-only ignore Gaia chunks.
 *
 * This module is independent from the renderer: it only shares src/core (math + format).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readCsv, num } from './csv.ts';
import { radecToWorld, SUN_GC, type Vec3 } from '../src/core/coords.ts';
import { absoluteMagnitude, packAbsMag, rgbFromTemp, tempFromBV, tempFromBpRp } from '../src/core/photometry.ts';
import { bpRpFromTemp, encodeProps } from '../src/core/spectral.ts';
import {
  CATALOG_FORMAT_VERSION, META_RECORD_BYTES, MetaFlag, MetaOffset, Source,
  type CatalogIndex, type CatalogNode, type NameRow,
} from '../src/core/format.ts';

const args = new Set(process.argv.slice(2));
const SAMPLE = args.has('--sample');
const HYG_PATH = SAMPLE ? 'pipeline/sample/hyg-sample.csv' : 'data-raw/hygdata_v41.csv';
const GAIA_DIR = 'data-raw/gaia';
const OUT = 'public/data/catalog';

const NODE_CAPACITY = 16384;
const ROOT_HALF = 8192; // pc; root cube centred on the Sun
const MAX_DEPTH = 14;

// ---------------------------------------------------------------- star table (columnar)
interface Star {
  source: number;
  flags: number;
  hip: number;
  gaiaId: bigint;
  hygId: number; // -1 if none
  ra: number;
  dec: number;
  dist: number;
  distLo: number;
  distHi: number;
  plx: number;
  plxErr: number;
  mag: number;
  color: number; // BP-RP (Gaia) or B-V (HYG)
  absMag: number;
  ruwe: number; // Gaia renormalised unit weight error (NaN for HYG)
  w: Vec3;
}
// ~850k objects only exist inside this build script; the app never materialises them.
const stars: Star[] = [];

interface HygRow {
  id: number; hip: number; hd: number; hr: number; gl: string; proper: string; bayer: string; flam: string;
  con: string; spect: string; ra: number; dec: number; dist: number; mag: number; absmag: number; ci: number;
  used: boolean;
}

const GREEK: Record<string, string> = {
  Alp: 'α', Bet: 'β', Gam: 'γ', Del: 'δ', Eps: 'ε', Zet: 'ζ', Eta: 'η', The: 'θ', Iot: 'ι', Kap: 'κ', Lam: 'λ',
  Mu: 'μ', Nu: 'ν', Xi: 'ξ', Omi: 'ο', Pi: 'π', Rho: 'ρ', Sig: 'σ', Tau: 'τ', Ups: 'υ', Phi: 'φ', Chi: 'χ',
  Psi: 'ψ', Ome: 'ω',
};
function bayerFlamsteed(h: HygRow): string {
  if (h.bayer) {
    const m = /^([A-Za-z]+)(-?\d*)$/.exec(h.bayer);
    const g = m ? (GREEK[m[1]] ?? m[1]) + (m[2] ? m[2].replace('-', '') : '') : h.bayer;
    return `${g} ${h.con}`;
  }
  if (h.flam) return `${h.flam} ${h.con}`;
  return '';
}

async function loadHyg(): Promise<HygRow[]> {
  const rows: HygRow[] = [];
  await readCsv(HYG_PATH, (g) => {
    rows.push({
      id: Number(g('id')), hip: num(g('hip')) || 0, hd: num(g('hd')) || 0, hr: num(g('hr')) || 0,
      gl: g('gl'), proper: g('proper'), bayer: g('bayer'), flam: g('flam'), con: g('con'), spect: g('spect'),
      ra: num(g('ra')) * 15, dec: num(g('dec')), dist: num(g('dist')), mag: num(g('mag')),
      absmag: num(g('absmag')), ci: num(g('ci')), used: false,
    });
  });
  return rows;
}

async function loadGaia(hygByHip: Map<number, HygRow>): Promise<number> {
  if (SAMPLE || args.has('--hyg-only') || !existsSync(GAIA_DIR)) return 0;
  const files = readdirSync(GAIA_DIR).filter((f) => /^[AB]_.*\.csv$/.test(f)).sort();
  let n = 0;
  const seen = new Set<bigint>();
  for (const f of files) {
    await readCsv(`${GAIA_DIR}/${f}`, (g) => {
      const sid = BigInt(g('source_id'));
      if (seen.has(sid)) return;
      seen.add(sid);
      const ra = num(g('ra')), dec = num(g('dec')), plx = num(g('parallax')), plxErr = num(g('parallax_error'));
      const rMed = num(g('r_med_geo'));
      let flags = 0, dist: number, lo: number, hi: number;
      if (rMed > 0) {
        dist = rMed; lo = num(g('r_lo_geo')); hi = num(g('r_hi_geo'));
        flags |= MetaFlag.BailerJonesDistance;
      } else {
        // parallax_over_error > 10 by selection, so 1/parallax is a reasonable estimator here
        dist = 1000 / plx; lo = 1000 / (plx + plxErr); hi = 1000 / (plx - plxErr);
        flags |= MetaFlag.InverseParallax;
      }
      if (!(dist > 0) || !isFinite(dist)) return;
      if ((hi - lo) / (2 * dist) > 0.2) flags |= MetaFlag.DistanceUncertain;
      const G = num(g('phot_g_mean_mag'));
      const hip = num(g('hip')) || 0;
      const h = hip ? hygByHip.get(hip) : undefined;
      let hygId = -1;
      if (h && !h.used) { h.used = true; hygId = h.id; flags |= MetaFlag.HipparcosMatch; }
      stars.push({
        source: Source.GaiaDR3, flags, hip, gaiaId: sid, hygId, ra, dec, dist,
        distLo: lo, distHi: hi, plx, plxErr, mag: G, color: num(g('bp_rp')),
        absMag: absoluteMagnitude(G, dist), ruwe: num(g('ruwe')), w: radecToWorld(ra, dec, dist),
      });
      n++;
    });
  }
  return n;
}

/**
 * HYG rows without a Hipparcos-ID match may still be in Gaia (e.g. Gliese stars, or Gaia
 * sources without a hipparcos2_best_neighbour entry). Match by angular separation
 * (generous 90" for proper motion between J2000 and J2016), distance and magnitude.
 */
function positionalMatch(hyg: HygRow[]): number {
  const CELL = 0.5; // deg
  const grid = new Map<string, number[]>();
  const key = (ra: number, dec: number) => `${Math.floor(ra / CELL)},${Math.floor((dec + 90) / CELL)}`;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    if (s.hygId >= 0) continue;
    const k = key(s.ra, s.dec);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  const R = 90 / 3600;
  let matched = 0;
  for (const h of hyg) {
    if (h.used || !(h.dist > 0 && h.dist < 1e5)) continue;
    let best = -1, bestSep = R;
    const cr = Math.floor(h.ra / CELL), cd = Math.floor((h.dec + 90) / CELL);
    for (let dr = -1; dr <= 1; dr++) for (let dd = -1; dd <= 1; dd++) {
      const cand = grid.get(`${(cr + dr + 720) % 720},${cd + dd}`);
      if (!cand) continue;
      for (const i of cand) {
        const s = stars[i];
        if (s.hygId >= 0) continue;
        const dRa = ((s.ra - h.ra + 540) % 360 - 180) * Math.cos(h.dec * Math.PI / 180);
        const sep = Math.hypot(dRa, s.dec - h.dec);
        if (sep < bestSep && Math.abs(s.dist - h.dist) / h.dist < 0.3 && Math.abs(s.mag - h.mag) < 1.5) {
          best = i; bestSep = sep;
        }
      }
    }
    if (best >= 0) {
      stars[best].hygId = h.id;
      if (!stars[best].hip && h.hip) stars[best].hip = h.hip;
      h.used = true;
      matched++;
    }
  }
  return matched;
}

function addHygRemainder(hyg: HygRow[]): number {
  let n = 0;
  for (const h of hyg) {
    if (h.used) continue;
    const isSun = h.id === 0;
    // HYG uses dist >= 100000 for "no parallax"; such rows have no usable 3D position.
    if (!isSun && !(h.dist > 0 && h.dist < 1e5)) continue;
    let flags = 0;
    if (!isSun) flags |= MetaFlag.InverseParallax;
    // HYG has no parallax errors; Hipparcos sigma ~ 1 mas => >10% beyond ~100 pc, >20% beyond ~200 pc.
    if (h.dist > 200) flags |= MetaFlag.DistanceUncertain;
    h.used = true;
    stars.push({
      source: Source.Hipparcos, flags, hip: h.hip, gaiaId: 0n, hygId: h.id, ra: h.ra, dec: h.dec,
      dist: h.dist, distLo: NaN, distHi: NaN, plx: isSun ? NaN : 1000 / h.dist, plxErr: NaN,
      mag: h.mag, color: h.ci, absMag: h.absmag, ruwe: NaN,
      w: isSun ? ([...SUN_GC] as Vec3) : radecToWorld(h.ra, h.dec, h.dist),
    });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- octree
interface BuildNode extends CatalogNode { members: number[] }
const nodes: BuildNode[] = [];

function buildNode(members: number[], c: Vec3, h: number, depth: number, id: string): number {
  const idx = nodes.length;
  members.sort((a, b) => stars[a].absMag - stars[b].absMag || a - b);
  const own = members.length <= NODE_CAPACITY || depth >= MAX_DEPTH ? members : members.slice(0, NODE_CAPACITY);
  const node: BuildNode = { id, c, h, n: own.length, off: 0, mMin: 0, mMax: 0, ch: [], depth, members: own };
  node.mMin = stars[own[0]].absMag;
  node.mMax = stars[own[own.length - 1]].absMag;
  nodes.push(node);
  if (own.length < members.length) {
    const buckets: number[][] = Array.from({ length: 8 }, () => []);
    for (let k = own.length; k < members.length; k++) {
      const w = stars[members[k]].w;
      const o = (w[0] >= c[0] ? 1 : 0) | (w[1] >= c[1] ? 2 : 0) | (w[2] >= c[2] ? 4 : 0);
      buckets[o].push(members[k]);
    }
    const hh = h / 2;
    for (let o = 0; o < 8; o++) {
      if (!buckets[o].length) continue;
      const cc: Vec3 = [c[0] + (o & 1 ? hh : -hh), c[1] + (o & 2 ? hh : -hh), c[2] + (o & 4 ? hh : -hh)];
      node.ch.push(buildNode(buckets[o], cc, hh, depth + 1, id + o));
    }
  }
  return idx;
}

function colorOf(s: Star): [number, number, number] {
  if (isFinite(s.color)) return rgbFromTemp(s.source === Source.GaiaDR3 ? tempFromBpRp(s.color) : tempFromBV(s.color));
  return [1, 1, 1];
}

// ---------------------------------------------------------------- main
async function main() {
  const t0 = Date.now();
  const hyg = await loadHyg();
  const hygById = new Map(hyg.map((h) => [h.id, h]));
  const hygByHip = new Map<number, HygRow>();
  for (const h of hyg) if (h.hip) hygByHip.set(h.hip, h);
  console.log(`HYG rows: ${hyg.length}`);

  const nGaia = await loadGaia(hygByHip);
  const nHipMatch = stars.filter((s) => s.flags & MetaFlag.HipparcosMatch).length;
  const nPos = positionalMatch(hyg);
  const nHyg = addHygRemainder(hyg);
  console.log(`Gaia DR3: ${nGaia} (HIP id matches ${nHipMatch}, positional matches ${nPos}); HYG-only: ${nHyg}`);

  // Drop stars outside the root cube (badly constrained distances).
  const keep: number[] = [];
  let dropped = 0;
  for (let i = 0; i < stars.length; i++) {
    const w = stars[i].w;
    if (Math.abs(w[0] - SUN_GC[0]) < ROOT_HALF && Math.abs(w[1] - SUN_GC[1]) < ROOT_HALF && Math.abs(w[2] - SUN_GC[2]) < ROOT_HALF
      && isFinite(stars[i].absMag)) keep.push(i);
    else dropped++;
  }
  buildNode(keep, [...SUN_GC] as Vec3, ROOT_HALF, 0, 'r');

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(`${OUT}/nodes`, { recursive: true });

  const names: NameRow[] = [];
  let off = 0;
  let renderBytes = 0, metaBytes = 0;
  for (const node of nodes) {
    node.off = off;
    const n = node.members.length;
    const pos = new Float32Array(n * 3);
    const rgbm = new Uint8Array(n * 4);
    const props = new Uint8Array(n * 4);
    const meta = new DataView(new ArrayBuffer(n * META_RECORD_BYTES));
    for (let k = 0; k < n; k++) {
      const s = stars[node.members[k]];
      pos[k * 3] = s.w[0] - node.c[0];
      pos[k * 3 + 1] = s.w[1] - node.c[1];
      pos[k * 3 + 2] = s.w[2] - node.c[2];
      const [r, g, b] = colorOf(s);
      rgbm[k * 4] = Math.round(r * 255);
      rgbm[k * 4 + 1] = Math.round(g * 255);
      rgbm[k * 4 + 2] = Math.round(b * 255);
      rgbm[k * 4 + 3] = packAbsMag(s.absMag);

      const h = s.hygId >= 0 ? hygById.get(s.hygId) : undefined;
      // filterable props: catalogued spectral type when HYG has one, photometric estimate otherwise
      const isGaia = s.source === Source.GaiaDR3;
      const bpRp = isGaia ? s.color : isFinite(s.color) ? bpRpFromTemp(tempFromBV(s.color)) : NaN;
      props.set(encodeProps(h?.spect, bpRp, s.absMag, !isGaia && isFinite(bpRp), s.ruwe > 1.4), k * 4);
      let flags = s.flags;
      if (h && (h.proper || h.bayer || h.flam || h.hip || h.hd || h.hr || h.gl)) {
        flags |= MetaFlag.HasDesignation;
        names.push([off + k, h.proper, bayerFlamsteed(h), h.con, s.hip || h.hip, h.hd, h.hr, h.gl, h.spect]);
      }
      const o = k * META_RECORD_BYTES;
      meta.setUint8(o + MetaOffset.source, s.source);
      meta.setUint8(o + MetaOffset.flags, flags);
      meta.setUint32(o + MetaOffset.hip, s.hip, true);
      meta.setUint32(o + MetaOffset.gaiaLo, Number(s.gaiaId & 0xffffffffn), true);
      meta.setUint32(o + MetaOffset.gaiaHi, Number(s.gaiaId >> 32n), true);
      meta.setUint32(o + MetaOffset.hygId, s.hygId >= 0 ? s.hygId + 1 : 0, true);
      meta.setFloat64(o + MetaOffset.ra, s.ra, true);
      meta.setFloat64(o + MetaOffset.dec, s.dec, true);
      meta.setFloat32(o + MetaOffset.dist, s.dist, true);
      meta.setFloat32(o + MetaOffset.distLo, s.distLo, true);
      meta.setFloat32(o + MetaOffset.distHi, s.distHi, true);
      meta.setFloat32(o + MetaOffset.parallax, s.plx, true);
      meta.setFloat32(o + MetaOffset.parallaxErr, s.plxErr, true);
      meta.setFloat32(o + MetaOffset.mag, s.mag, true);
      meta.setFloat32(o + MetaOffset.color, s.color, true);
    }
    const render = new Uint8Array(pos.byteLength + rgbm.byteLength + props.byteLength);
    render.set(new Uint8Array(pos.buffer), 0);
    render.set(rgbm, pos.byteLength);
    render.set(props, pos.byteLength + rgbm.byteLength);
    writeFileSync(`${OUT}/nodes/${node.id}.bin`, render);
    writeFileSync(`${OUT}/nodes/${node.id}.meta.bin`, new Uint8Array(meta.buffer));
    renderBytes += render.byteLength;
    metaBytes += meta.byteLength;
    off += n;
  }

  const counts: Record<string, number> = { gaiaDR3: 0, hipparcos: 0, droppedOutsideRoot: dropped };
  for (const i of keep) counts[stars[i].source === Source.GaiaDR3 ? 'gaiaDR3' : 'hipparcos']++;

  const index: CatalogIndex = {
    version: CATALOG_FORMAT_VERSION,
    frame: 'galactocentric (astropy v4.0: R0=8122 pc, z_sun=20.8 pc), parsecs',
    units: 'pc',
    built: new Date().toISOString(),
    sample: SAMPLE,
    total: off,
    counts,
    sources: [
      {
        code: Source.GaiaDR3, name: 'Gaia DR3 + Bailer-Jones (2021) distances',
        citation: 'Gaia Collaboration, Vallenari et al. (2023) A&A 674, A1; Bailer-Jones et al. (2021) AJ 161, 147',
        license: 'ESA Gaia Archive terms (CC BY-SA 3.0 IGO)',
        selection: 'parallax_over_error > 10 AND (phot_g_mean_mag < 10 OR parallax > 10 mas)',
      },
      {
        code: Source.Hipparcos, name: 'HYG v4.1 (Hipparcos / Yale BSC / Gliese)',
        citation: 'D. Nash, HYG Database v4.1 (astronexus); ESA Hipparcos (1997), van Leeuwen (2007)',
        license: 'CC BY-SA 4.0',
        selection: SAMPLE ? 'SAMPLE: small real excerpt of HYG (pipeline/sample)' : 'rows with finite distance not present in the Gaia subset',
      },
    ],
    nodeCapacity: NODE_CAPACITY,
    nodes: nodes.map(({ members: _m, ...n }) => ({ ...n, c: n.c.map((v) => +v.toFixed(6)) as Vec3, mMin: +n.mMin.toFixed(3), mMax: +n.mMax.toFixed(3) })),
  };
  writeFileSync(`${OUT}/index.json`, JSON.stringify(index));
  writeFileSync(`${OUT}/names.json`, JSON.stringify(names));

  console.log(`Stars written: ${off} in ${nodes.length} nodes (max depth ${Math.max(...nodes.map((n) => n.depth))}); dropped ${dropped}`);
  console.log(`Render payload ${(renderBytes / 1e6).toFixed(1)} MB, metadata ${(metaBytes / 1e6).toFixed(1)} MB, names ${names.length}`);
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
