/**
 * Fetches a subset of Gaia DR3 from the ESA Gaia Archive TAP service (one query
 * per magnitude bin, never one request per star) and stores raw CSV files in data-raw/gaia/.
 *
 * Selection (documented in docs/DATA.md):
 *   parallax_over_error > 10                         -> fractional parallax error < 10%
 *   AND (phot_g_mean_mag < 10  OR  parallax > 10)    -> bright stars out to kpc + 100 pc volume
 * Distances: Bailer-Jones et al. (2021) geometric distances (external.gaiaedr3_distance).
 * Hipparcos cross-match: gaiadr3.hipparcos2_best_neighbour (used to merge with HYG names).
 */
import { mkdirSync, existsSync, statSync, renameSync, readdirSync, writeFileSync } from 'node:fs';

const TAP = 'https://gea.esac.esa.int/tap-server/tap';
export const GAIA_DIR = 'data-raw/gaia';

/**
 * Anonymous Gaia Archive async jobs are aborted after 60 s and sync queries are truncated at
 * 50 000 rows, so the selection is split into bins of G magnitude (an indexed column). A bin
 * that is truncated or times out is split in half and retried, so bin sizes adapt. Each bin is saved as its own CSV.
 *
 *   part A: parallax_over_error > 10 AND G < 10              (bright stars, out to kpc)
 *   part B: parallax_over_error > 10 AND parallax > 10 AND G >= 10   (faint stars within 100 pc)
 */
const INITIAL_BINS: Array<[string, number, number]> = [
  ['A', -5, 6], ['A', 6, 7], ['A', 7, 7.5], ['A', 7.5, 8], ['A', 8, 8.25], ['A', 8.25, 8.5],
  ...range(8.5, 9, 0.125).map((g): [string, number, number] => ['A', g, g + 0.125]),
  ...range(9, 9.5, 0.1).map((g): [string, number, number] => ['A', g, g + 0.1]),
  ...range(9.5, 10, 0.05).map((g): [string, number, number] => ['A', g, g + 0.05]),
  ...range(10, 21, 0.5).map((g): [string, number, number] => ['B', g, g + 0.5]),
  ['B', 21, 30],
];

function range(a: number, b: number, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; a + i * step < b - 1e-9; i++) out.push(+(a + i * step).toFixed(4));
  return out;
}

export function gaiaQuery(part: string, gLo: number, gHi: number): string {
  const sel = part === 'A' ? '' : 'AND g.parallax > 10';
  return `
SELECT g.source_id, g.ra, g.dec, g.parallax, g.parallax_error, g.ruwe,
       g.phot_g_mean_mag, g.bp_rp,
       d.r_med_geo, d.r_lo_geo, d.r_hi_geo,
       h.original_ext_source_id AS hip
FROM gaiadr3.gaia_source AS g
LEFT OUTER JOIN external.gaiaedr3_distance AS d ON d.source_id = g.source_id
LEFT OUTER JOIN gaiadr3.hipparcos2_best_neighbour AS h ON h.source_id = g.source_id
WHERE g.phot_g_mean_mag >= ${gLo} AND g.phot_g_mean_mag < ${gHi}
  AND g.parallax_over_error > 10 ${sel}
`.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Synchronous TAP queries respond fastest but silently truncate at SYNC_ROW_LIMIT rows. */
const SYNC_ROW_LIMIT = 50_000;

class TooLarge extends Error {}

async function runQuery(query: string, out: string): Promise<number> {
  const body = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: query });
  const res = await fetch(`${TAP}/sync`, { method: 'POST', body, signal: AbortSignal.timeout(600_000) });
  const text = await res.text();
  if (!res.ok || text.startsWith('<?xml')) {
    if (res.status === 408 || /execution time/i.test(text)) throw new TooLarge('time limit');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const rows = text.split('\n').filter((l) => l.length > 0).length - 1;
  if (rows >= SYNC_ROW_LIMIT) throw new TooLarge(`${rows} rows (truncated)`);
  // When the 60 s execution limit hits mid-stream the server silently stops after a whole
  // number of 8192-row blocks (+1). Observed in practice; treat it as truncation.
  if (rows > 1 && rows % 8192 === 1) throw new TooLarge(`${rows} rows (stream cut at block boundary)`);
  writeFileSync(`${out}.part`, text);
  renameSync(`${out}.part`, out);
  return rows;
}

async function main() {
  mkdirSync(GAIA_DIR, { recursive: true });
  const queue = INITIAL_BINS.filter(([p, a, b]) => !existsSync(binPath(p, a, b)) && !isCoveredBySplits(p, a, b));
  console.log(`${INITIAL_BINS.length - queue.length}/${INITIAL_BINS.length} bins already present`);
  const PARALLEL = 4;
  let failed = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (queue.length) {
      const [p, a, b] = queue.shift()!;
      const out = binPath(p, a, b);
      if (existsSync(out)) continue;
      for (let attempt = 1; ; attempt++) {
        try {
          const t0 = Date.now();
          const rows = await runQuery(gaiaQuery(p, a, b), out);
          console.log(`${p} G[${a},${b}) ok ${rows} rows, ${(statSync(out).size / 1e6).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
          break;
        } catch (e) {
          if (e instanceof TooLarge && b - a > 0.004) {
            const m = +((a + b) / 2).toFixed(4);
            console.log(`${p} G[${a},${b}) ${e.message} -> split at ${m}`);
            queue.unshift([p, a, m], [p, m, b]);
            break;
          }
          console.warn(`${p} G[${a},${b}) attempt ${attempt} failed: ${String(e).slice(0, 160)}`);
          if (attempt >= 3) { failed++; break; }
          await sleep(10000);
        }
      }
    }
  }));
  if (failed) throw new Error(`${failed} bins failed; rerun to retry only the missing ones.`);
  console.log('All Gaia bins downloaded.');
}

const fmt = (g: number) => (g < 0 ? 'm' : '') + Math.abs(g).toFixed(4).padStart(7, '0');
export const binPath = (p: string, a: number, b: number) => `${GAIA_DIR}/${p}_${fmt(a)}_${fmt(b)}.csv`;

/** True if a previously split bin is fully covered by smaller files. */
function isCoveredBySplits(p: string, a: number, b: number): boolean {
  if (!existsSync(GAIA_DIR)) return false;
  const files = readdirSync(GAIA_DIR)
    .map((f) => /^([AB])_(m?)([\d.]+)_(m?)([\d.]+)\.csv$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m && m[1] === p)
    .map((m) => [(m[2] ? -1 : 1) * +m[3], (m[4] ? -1 : 1) * +m[5]] as [number, number])
    .filter(([x, y]) => x >= a - 1e-9 && y <= b + 1e-9)
    .sort((u, v) => u[0] - v[0]);
  let cur = a;
  for (const [x, y] of files) {
    if (Math.abs(x - cur) > 1e-6) return false;
    cur = y;
  }
  return Math.abs(cur - b) < 1e-6;
}

if (process.argv[1]?.endsWith('fetch-gaia.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
