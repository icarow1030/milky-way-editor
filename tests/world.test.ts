import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coerceValue, parseWorldFile, sanitizeFieldDef, WorldFileError, WORLD_FILE_FORMAT, type FieldDef, type StarAnchor,
} from '../src/world/model.ts';
import { MemoryRepo } from '../src/world/repo.ts';
import { WorldService } from '../src/world/WorldService.ts';

const anchor = (index: number, ids = [`gaia-dr3:${1000 + index}`], build = 'b1'): StarAnchor =>
  ({ ids, catalogBuild: build, index, ra: 10, dec: 20, dist: 5, label: ids[0] });

function service(build = 'b1', resolveMap: Record<string, number> = {}, repo = new MemoryRepo()) {
  let current = build;
  const svc = new WorldService(repo, {
    catalogBuild: () => current,
    resolve: async (ids) => ids.map((i) => resolveMap[i]).find((x) => x !== undefined) ?? null,
    saveDelayMs: 1,
  });
  return { svc, repo, setBuild: (b: string) => (current = b) };
}

test('coerceValue enforces field types', () => {
  const def = (type: FieldDef['type'], options: string[] = []) => sanitizeFieldDef({ type, options }, new Set());
  assert.equal(coerceValue(def('number'), '3,5'), 3.5);
  assert.equal(coerceValue(def('number'), 'abc'), undefined);
  assert.equal(coerceValue(def('number'), ''), undefined);
  assert.equal(coerceValue(def('bool'), 'sim'), true);
  assert.equal(coerceValue(def('select', ['a', 'b']), 'b'), 'b');
  assert.equal(coerceValue(def('select', ['a', 'b']), 'c'), undefined);
  assert.deepEqual(coerceValue(def('multiselect', ['a', 'b', 'c']), ['c', 'x', 'a']), ['a', 'c']);
  assert.equal(coerceValue(def('text'), ''), undefined);
});

test('parseWorldFile rejects foreign or future files and sanitises content', () => {
  assert.throws(() => parseWorldFile({ format: 'x' }), WorldFileError);
  assert.throws(() => parseWorldFile({ format: WORLD_FILE_FORMAT, formatVersion: 99, world: { id: 'w' } }), /mais nova/);
  const f = parseWorldFile({
    format: WORLD_FILE_FORMAT, formatVersion: 1,
    world: {
      id: 'world:1', name: '  ', tags: [{ id: 't:a', name: 'A', color: 'red' }],
      fields: [{ id: 'f:pop', label: 'População', type: 'number' }, { id: 'f:pop', label: 'dup', type: 'text' }],
    },
    entities: [
      { id: 'user:1', kind: 'star', anchor: anchor(3), tags: ['t:a', 't:missing'], fields: { 'f:pop': '12', 'f:gone': 1 } },
      { id: 'user:2', kind: 'star', anchor: null }, // stars must be anchored in this schema
      { id: 'user:1', kind: 'star', anchor: anchor(4) }, // duplicate id
      { id: 'user:3', kind: 'planet', anchor: anchor(5) }, // unknown kind
    ],
  });
  assert.equal(f.world.name, 'Sem nome');
  assert.equal(f.world.tags[0].color, '#b49cff', 'invalid colour replaced');
  assert.equal(f.world.fields.length, 1, 'duplicate field id dropped');
  assert.equal(f.entities.length, 1);
  assert.deepEqual(f.entities[0].tags, ['t:a']);
  assert.deepEqual(f.entities[0].fields, { 'f:pop': 12 });
  assert.equal(f.entities[0].worldId, 'world:1');
});

test('service: first run creates a world; annotations persist across reloads', async () => {
  const { svc, repo } = service();
  await svc.init(null);
  assert.equal(svc.worlds.length, 1);
  const e = svc.annotate(anchor(7));
  assert.equal(svc.annotate(anchor(7)).id, e.id, 'same star -> same entity');
  const tag = svc.addTag('Colônia');
  const fld = svc.addField({ label: 'População', type: 'number', unit: 'hab.' });
  svc.updateEntity(e.id, { name: 'Kharos', tags: [tag.id, 't:nope'], fields: { [fld.id]: '1200', 'f:unknown': 3 } });
  await svc.flush();

  const again = service('b1', {}, repo).svc;
  await again.init(svc.active!.id);
  const loaded = again.entityForStar(7)!;
  assert.equal(loaded.name, 'Kharos');
  assert.deepEqual(loaded.tags, [tag.id]);
  assert.deepEqual(loaded.fields, { [fld.id]: 1200 });
  assert.equal(again.active!.fields[0].unit, 'hab.');
});

test('service: deleting tags/fields cascades; type changes convert values; option renames follow', async () => {
  const { svc } = service();
  await svc.init(null);
  const a = svc.annotate(anchor(1)), b = svc.annotate(anchor(2));
  const t = svc.addTag('x');
  const f = svc.addField({ label: 'Classe', type: 'select', options: ['minerador', 'militar'] });
  svc.updateEntity(a.id, { tags: [t.id], fields: { [f.id]: 'militar' } });
  svc.updateEntity(b.id, { tags: [t.id], fields: { [f.id]: 'minerador' } });
  assert.equal(svc.usage('tag', t.id), 2);

  svc.updateField(f.id, { options: ['mineração', 'militar'] }, { minerador: 'mineração' });
  assert.equal(svc.entities.get(b.id)!.fields[f.id], 'mineração', 'renamed option followed');

  svc.updateField(f.id, { type: 'multiselect' });
  assert.deepEqual(svc.entities.get(a.id)!.fields[f.id], ['militar'], 'select -> multiselect keeps value');

  svc.updateField(f.id, { type: 'number' });
  assert.equal(svc.usage('field', f.id), 0, 'values that cannot be numbers are dropped');

  svc.deleteTag(t.id);
  assert.equal(svc.usage('tag', t.id), 0);
  assert.equal(svc.active!.tags.length, 0);
  const g = svc.addField({ label: 'Nota', type: 'text' });
  svc.updateEntity(a.id, { fields: { [g.id]: 'oi' } });
  svc.deleteField(g.id);
  assert.equal(g.id in svc.entities.get(a.id)!.fields, false);
});

test('service: export -> import (replace and copy) round-trips', async () => {
  const { svc } = service();
  await svc.init(null);
  svc.updateWorld({ name: 'Andrômeda Perdida', description: 'teste' });
  const t = svc.addTag('Império', '#e57f7f');
  const e = svc.annotate(anchor(42));
  svc.updateEntity(e.id, { name: 'Capital', tags: [t.id] });
  const file = JSON.parse(JSON.stringify(await svc.exportWorld()));
  const originalId = svc.active!.id;

  await svc.deleteWorld(originalId);
  assert.equal(svc.hasWorld(originalId), false);
  const restored = await svc.importWorld(file, 'replace');
  assert.equal(restored.id, originalId);
  assert.equal(svc.entityForStar(42)!.name, 'Capital');
  assert.equal(svc.active!.name, 'Andrômeda Perdida');

  const copy = await svc.importWorld(file, 'copy');
  assert.notEqual(copy.id, originalId);
  // 'Meu universo' (recreated when the last world was deleted) + restored + copy
  assert.equal(svc.worlds.length, 3);
  assert.equal(svc.entityForStar(42)!.name, 'Capital');
  assert.notEqual(svc.entityForStar(42)!.id, e.id, 'copied entities get new ids');
});

test('service: anchors are re-linked after a catalogue rebuild, or become orphans', async () => {
  const repo = new MemoryRepo();
  const first = service('b1', {}, repo).svc;
  await first.init(null);
  const kept = first.annotate(anchor(10, ['gaia-dr3:555', 'hip:32349']));
  const lost = first.annotate(anchor(11, ['gaia-dr3:999']));
  await first.flush();

  // new build: the star now sits at index 77 and is found by its HIP id
  const { svc } = service('b2', { 'hip:32349': 77 }, repo);
  await svc.init(first.active!.id);
  assert.equal(svc.entityForStar(77)?.id, kept.id);
  assert.equal(svc.entityForStar(10), undefined);
  assert.equal(svc.orphans.has(lost.id), true);
  assert.equal(svc.entities.has(lost.id), true, 'orphans are never deleted');
  await svc.flush();
  const stored = (await repo.loadEntities(first.active!.id)).find((e) => e.id === kept.id)!;
  assert.equal(stored.anchor!.catalogBuild, 'b2');
  assert.equal(stored.anchor!.index, 77);
});

test('service: duplicate and delete worlds', async () => {
  const { svc } = service();
  await svc.init(null);
  svc.annotate(anchor(1));
  const dup = await svc.duplicateWorld(svc.active!.id);
  await svc.setActive(dup.id);
  assert.equal(svc.entities.size, 1);
  await svc.deleteWorld(dup.id);
  assert.equal(svc.worlds.length, 1);
  assert.notEqual(svc.active!.id, dup.id);
});
