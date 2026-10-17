import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { META_RECORD_BYTES, RENDER_BYTES_PER_STAR, readMetaRecord, persistentId, Source, idShardOf, starIds, type CatalogIndex, type NameRow } from '../src/core/format.ts';
import { packAbsMag, unpackAbsMag, tempFromBV, tempFromBpRp } from '../src/core/photometry.ts';
import { radecToWorld, SUN_GC } from '../src/core/coords.ts';
import { generateGalaxy } from '../src/render/galaxyModel.ts';

const DIR = 'public/data/catalog';
const hasCatalog = existsSync(`${DIR}/index.json`);

test('absolute magnitude packing round-trips within 1/16 mag', () => {
  for (const m of [-11.9, -5, 0, 4.83, 10.3, 19.8]) assert.ok(Math.abs(unpackAbsMag(packAbsMag(m)) - m) <= 0.0625);
  assert.equal(packAbsMag(-50), 0);
  assert.equal(packAbsMag(50), 255);
});

test('colour temperatures are sane for the Sun', () => {
  assert.ok(Math.abs(tempFromBV(0.656) - 5800) < 200);
  assert.ok(Math.abs(tempFromBpRp(0.82) - 5770) < 250);
});

test('persistent ids prefer Gaia, then HIP, then HYG', () => {
  assert.equal(persistentId({ source: Source.GaiaDR3, gaiaSourceId: 123n, hip: 5, hygId: 7 }), 'gaia-dr3:123');
  assert.equal(persistentId({ source: Source.Hipparcos, gaiaSourceId: null, hip: 32349, hygId: 1 }), 'hip:32349');
  assert.equal(persistentId({ source: Source.Hipparcos, gaiaSourceId: null, hip: 0, hygId: 0 }), 'hyg:0');
});

test('procedural galaxy is deterministic', () => {
  const a = generateGalaxy(5000, 42), b = generateGalaxy(5000, 42), c = generateGalaxy(5000, 43);
  assert.deepEqual(a.positions, b.positions);
  assert.notDeepEqual(a.positions, c.positions);
});

test('catalog octree invariants', { skip: !hasCatalog && 'no catalog built' }, () => {
  const index: CatalogIndex = JSON.parse(readFileSync(`${DIR}/index.json`, 'utf8'));
  let expectedOff = 0;
  for (const n of index.nodes) {
    assert.equal(n.off, expectedOff, `contiguous offsets at ${n.id}`);
    expectedOff += n.n;
    assert.equal(statSync(`${DIR}/nodes/${n.id}.bin`).size, n.n * RENDER_BYTES_PER_STAR, `render size ${n.id}`);
    assert.equal(statSync(`${DIR}/nodes/${n.id}.meta.bin`).size, n.n * META_RECORD_BYTES, `meta size ${n.id}`);
    for (const ci of n.ch) {
      const c = index.nodes[ci];
      assert.ok(c.mMin >= n.mMax - 1e-3, `child ${c.id} brighter than parent ${n.id}`);
      assert.equal(c.depth, n.depth + 1);
      assert.ok(c.id.startsWith(n.id));
    }
  }
  assert.equal(expectedOff, index.total);
});

test('catalog positions agree with metadata (ra, dec, dist -> world)', { skip: !hasCatalog && 'no catalog built' }, () => {
  const index: CatalogIndex = JSON.parse(readFileSync(`${DIR}/index.json`, 'utf8'));
  for (const n of index.nodes.slice(0, 6)) {
    const render = readFileSync(`${DIR}/nodes/${n.id}.bin`);
    const pos = new Float32Array(render.buffer.slice(render.byteOffset, render.byteOffset + n.n * 12));
    const metaBuf = readFileSync(`${DIR}/nodes/${n.id}.meta.bin`);
    const view = new DataView(metaBuf.buffer, metaBuf.byteOffset, metaBuf.byteLength);
    for (let k = 0; k < n.n; k += Math.max(1, Math.floor(n.n / 200))) {
      const m = readMetaRecord(view, k, n.off + k);
      const w = m.dist > 0 ? radecToWorld(m.ra, m.dec, m.dist) : SUN_GC;
      const p = [n.c[0] + pos[k * 3], n.c[1] + pos[k * 3 + 1], n.c[2] + pos[k * 3 + 2]];
      const err = Math.hypot(p[0] - w[0], p[1] - w[1], p[2] - w[2]);
      // float32 node-relative storage: error grows with offset from node centre (and float32 dist)
      assert.ok(err < 1e-3 + 1e-6 * m.dist, `star ${n.off + k} in ${n.id}: ${err} pc`);
    }
  }
});

test('known stars resolve by name with correct distances', { skip: !hasCatalog && 'no catalog built' }, () => {
  const names: NameRow[] = JSON.parse(readFileSync(`${DIR}/names.json`, 'utf8'));
  const index: CatalogIndex = JSON.parse(readFileSync(`${DIR}/index.json`, 'utf8'));
  const find = (proper: string) => names.find((r) => r[1] === proper);
  const metaOf = (gi: number) => {
    const node = index.nodes.find((n) => gi >= n.off && gi < n.off + n.n)!;
    const b = readFileSync(`${DIR}/nodes/${node.id}.meta.bin`);
    return readMetaRecord(new DataView(b.buffer, b.byteOffset, b.byteLength), gi - node.off, gi);
  };
  // [name, expected distance pc, tolerance]
  const cases: Array<[string, number, number]> = [['Sirius', 2.64, 0.05], ['Vega', 7.68, 0.15], ['Sol', 0, 1e-9]];
  if (!index.sample) cases.push(['Betelgeuse', 150, 80]);
  for (const [name, d, tol] of cases) {
    const r = find(name);
    assert.ok(r, `${name} present`);
    const m = metaOf(r![0]);
    assert.ok(Math.abs(m.dist - d) <= tol, `${name} distance ${m.dist}`);
  }
});

test('identifier map resolves every sampled star back to its index', { skip: !hasCatalog && 'no catalog built' }, () => {
  const index: CatalogIndex = JSON.parse(readFileSync(`${DIR}/index.json`, 'utf8'));
  assert.match(index.buildId, /^[0-9a-f]{8}-\d+$/);
  const shards = new Map<string, Record<string, number>>();
  const shard = (k: string) => shards.get(k) ?? shards.set(k, JSON.parse(readFileSync(`${DIR}/ids/${k}.json`, 'utf8'))).get(k)!;
  let checked = 0, total = 0;
  for (let s = 0; s < index.idShards; s++) total += Object.keys(shard(s.toString(16).padStart(2, '0'))).length;
  assert.ok(total >= index.total, `at least one id per star (${total} ids, ${index.total} stars)`);
  for (const n of index.nodes) {
    const b = readFileSync(`${DIR}/nodes/${n.id}.meta.bin`);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let k = 0; k < n.n; k += Math.max(1, Math.floor(n.n / 50))) {
      const m = readMetaRecord(view, k, n.off + k);
      const primary = starIds(m)[0];
      assert.equal(shard(idShardOf(primary, index.idShards))[primary], n.off + k, primary);
      checked++;
    }
  }
  assert.ok(checked > 1000);
});
