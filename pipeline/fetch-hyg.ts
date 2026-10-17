/**
 * Downloads the HYG stellar database v4.1 (Hipparcos + Yale Bright Star + Gliese),
 * by David Nash / astronexus, CC BY-SA 4.0. Used for proper names, Bayer/Flamsteed,
 * HD/HR/Gliese designations, and for bright stars that are saturated or missing in Gaia.
 */
import { mkdirSync, createWriteStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const URL_HYG = 'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv';
const OUT = 'data-raw/hygdata_v41.csv';

async function main() {
  if (existsSync(OUT) && !process.argv.includes('--force')) {
    console.log(`${OUT} already exists. Use --force to refetch.`);
    return;
  }
  mkdirSync('data-raw', { recursive: true });
  const res = await fetch(URL_HYG);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(OUT));
  console.log(`Saved ${OUT} (${(statSync(OUT).size / 1e6).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
