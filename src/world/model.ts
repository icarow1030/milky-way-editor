/**
 * World (authorial data) model. Pure TypeScript, no DOM/IndexedDB, so it is testable in Node.
 *
 * A World is a user project. Everything authored lives in Entities that belong to a World and
 * never modify the scientific catalogue. An Entity anchored to a catalogue star is an
 * annotation of that real star; later phases add unanchored entities (fictional stars,
 * systems, bodies, factions…) with the same shape.
 */

export const WORLD_SCHEMA_VERSION = 1;
export const WORLD_FILE_FORMAT = 'galactic-atlas-world';

export type EntityKind = 'star';
export const ENTITY_KINDS: readonly EntityKind[] = ['star'];

export type FieldType = 'text' | 'longtext' | 'number' | 'select' | 'multiselect' | 'bool';
export const FIELD_TYPES: readonly FieldType[] = ['text', 'longtext', 'number', 'select', 'multiselect', 'bool'];
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'texto curto', longtext: 'texto longo', number: 'número', select: 'escolha única',
  multiselect: 'múltipla escolha', bool: 'sim / não',
};

export interface FieldDef {
  id: string; // stable key used in Entity.fields; never reused
  label: string;
  type: FieldType;
  options: string[]; // select / multiselect
  unit: string; // number
  kinds: EntityKind[];
}

export interface TagDef {
  id: string;
  name: string;
  color: string; // #rrggbb
}

export interface WorldMeta {
  id: string;
  name: string;
  description: string;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
  tags: TagDef[];
  fields: FieldDef[];
}

export type FieldValue = string | number | boolean | string[];

/** Link to a catalogue star. `ids` holds every identifier known for it (Gaia, HIP, HYG), so the
 *  link survives catalogue rebuilds and changes of primary identifier. ra/dec/dist are a snapshot
 *  used to draw markers without loading catalogue nodes. `index` is only valid for `catalogBuild`. */
export interface StarAnchor {
  ids: string[];
  catalogBuild: string;
  index: number;
  ra: number;
  dec: number;
  dist: number;
  label: string; // catalogue designation at annotation time, for orphan display
}

export interface Entity {
  id: string;
  worldId: string;
  kind: EntityKind;
  anchor: StarAnchor | null;
  name: string;
  description: string;
  tags: string[]; // TagDef ids
  fields: Record<string, FieldValue>; // FieldDef id -> value
  createdAt: number;
  updatedAt: number;
  rev: number;
}

export interface WorldFile {
  format: typeof WORLD_FILE_FORMAT;
  formatVersion: number;
  exportedAt: string;
  catalogBuild: string | null;
  world: WorldMeta;
  entities: Entity[];
}

export const AUTHORIAL_COLOR = '#b49cff';
export const TAG_PALETTE = ['#b49cff', '#7fd3c4', '#e0b25c', '#e57f7f', '#8cc4ff', '#9fd67a', '#d98ad1', '#c9c9c9'];

export const newId = (prefix = 'user'): string => `${prefix}:${crypto.randomUUID()}`;

export function createWorld(name: string, now = Date.now()): WorldMeta {
  return {
    id: newId('world'), name: name.trim() || 'Sem nome', description: '', schemaVersion: WORLD_SCHEMA_VERSION,
    createdAt: now, updatedAt: now, tags: [], fields: [],
  };
}

export function createEntity(worldId: string, kind: EntityKind, anchor: StarAnchor | null, now = Date.now()): Entity {
  return {
    id: newId(), worldId, kind, anchor, name: '', description: '', tags: [], fields: {},
    createdAt: now, updatedAt: now, rev: 1,
  };
}

// ------------------------------------------------------------------ values

/** Coerces a raw value to a field's type. Returns undefined when it cannot be represented
 *  (the value is then dropped rather than stored in a wrong shape). */
export function coerceValue(def: FieldDef, v: unknown): FieldValue | undefined {
  if (v === undefined || v === null) return undefined;
  switch (def.type) {
    case 'text':
    case 'longtext': {
      const s = Array.isArray(v) ? v.join(', ') : String(v);
      return s === '' ? undefined : s;
    }
    case 'number': {
      if (typeof v === 'boolean') return undefined;
      const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
      return String(v).trim() === '' || !isFinite(n) ? undefined : n;
    }
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'sim') return true;
      if (v === 'false' || v === 'não') return false;
      return undefined;
    case 'select': {
      const s = Array.isArray(v) ? v[0] : String(v);
      return s !== undefined && def.options.includes(s) ? s : undefined;
    }
    case 'multiselect': {
      const arr = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim());
      const ok = def.options.filter((o) => arr.includes(o)); // keeps option order, drops unknowns
      return ok.length ? ok : undefined;
    }
  }
}

export function sanitizeFieldDef(raw: Partial<FieldDef>, existingIds: Set<string>): FieldDef {
  const type = FIELD_TYPES.includes(raw.type as FieldType) ? (raw.type as FieldType) : 'text';
  const options = type === 'select' || type === 'multiselect'
    ? [...new Set((raw.options ?? []).map((o) => String(o).trim()).filter(Boolean))]
    : [];
  let id = raw.id && /^f:[\w-]+$/.test(raw.id) ? raw.id : `f:${crypto.randomUUID().slice(0, 8)}`;
  while (!raw.id && existingIds.has(id)) id = `f:${crypto.randomUUID().slice(0, 8)}`;
  const kinds = (raw.kinds ?? ['star']).filter((k): k is EntityKind => ENTITY_KINDS.includes(k as EntityKind));
  return {
    id, label: String(raw.label ?? '').trim() || 'Campo', type, options,
    unit: type === 'number' ? String(raw.unit ?? '').trim() : '', kinds: kinds.length ? kinds : ['star'],
  };
}

export function sanitizeTag(raw: Partial<TagDef>): TagDef {
  const color = /^#[0-9a-f]{6}$/i.test(raw.color ?? '') ? raw.color!.toLowerCase() : TAG_PALETTE[0];
  return {
    id: raw.id && /^t:[\w-]+$/.test(raw.id) ? raw.id : `t:${crypto.randomUUID().slice(0, 8)}`,
    name: String(raw.name ?? '').trim() || 'etiqueta', color,
  };
}

/** Re-coerces every stored value after a field definition changed (type or options).
 *  Option renames are given as a map so values follow the rename instead of being dropped. */
export function migrateFieldValues(entities: Entity[], def: FieldDef, renames: Record<string, string> = {}): Entity[] {
  const changed: Entity[] = [];
  for (const e of entities) {
    if (!(def.id in e.fields)) continue;
    const before = e.fields[def.id];
    const renamed = Array.isArray(before) ? before.map((x) => renames[x] ?? x)
      : typeof before === 'string' ? renames[before] ?? before : before;
    const after = coerceValue(def, renamed);
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    const fields = { ...e.fields };
    if (after === undefined) delete fields[def.id];
    else fields[def.id] = after;
    changed.push({ ...e, fields });
  }
  return changed;
}

/** Entities that use a tag / field (for "used by N" warnings and cascading deletes). */
export const entitiesWithTag = (entities: Iterable<Entity>, tagId: string) => [...entities].filter((e) => e.tags.includes(tagId));
export const entitiesWithField = (entities: Iterable<Entity>, fieldId: string) => [...entities].filter((e) => fieldId in e.fields);

// ------------------------------------------------------------------ files

/** Upgrades older world files in place. Add one step per schema version bump. */
const MIGRATIONS: Record<number, (f: WorldFile) => WorldFile> = {
  // 1 -> 2: (future) e.g. f.entities.forEach((e) => (e.newProp = default))
};

export class WorldFileError extends Error {}

/** Validates, migrates and normalises an imported/stored world file. Never trusts the input. */
export function parseWorldFile(input: unknown): WorldFile {
  const o = input as Partial<WorldFile> | null;
  if (!o || typeof o !== 'object' || o.format !== WORLD_FILE_FORMAT) {
    throw new WorldFileError('Arquivo não é um mundo do Galactic Atlas.');
  }
  let file = o as WorldFile;
  let v = Number(file.formatVersion);
  if (!Number.isInteger(v) || v < 1) throw new WorldFileError('Versão de formato inválida.');
  if (v > WORLD_SCHEMA_VERSION) {
    throw new WorldFileError(`Arquivo de uma versão mais nova (v${v}); atualize o aplicativo.`);
  }
  while (v < WORLD_SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new WorldFileError(`Sem migração da versão ${v}.`);
    file = step(file);
    v++;
  }
  const w = file.world as Partial<WorldMeta> | undefined;
  if (!w || typeof w !== 'object' || typeof w.id !== 'string') throw new WorldFileError('Mundo sem identificador.');

  const tags = (Array.isArray(w.tags) ? w.tags : []).map(sanitizeTag);
  const fieldIds = new Set<string>();
  const fields = (Array.isArray(w.fields) ? w.fields : []).map((f) => {
    const d = sanitizeFieldDef(f, fieldIds);
    fieldIds.add(d.id);
    return d;
  });
  const world: WorldMeta = {
    id: w.id, name: String(w.name ?? '').trim() || 'Sem nome', description: String(w.description ?? ''),
    schemaVersion: WORLD_SCHEMA_VERSION, createdAt: num(w.createdAt, Date.now()), updatedAt: num(w.updatedAt, Date.now()),
    tags: dedupeBy(tags, (t) => t.id), fields: dedupeBy(fields, (f) => f.id),
  };
  const tagIds = new Set(world.tags.map((t) => t.id));
  const defs = new Map(world.fields.map((f) => [f.id, f]));
  const entities = dedupeBy((Array.isArray(file.entities) ? file.entities : []).map((e) => sanitizeEntity(e, world.id, tagIds, defs))
    .filter((e): e is Entity => e !== null), (e) => e.id);
  return {
    format: WORLD_FILE_FORMAT, formatVersion: WORLD_SCHEMA_VERSION, exportedAt: String(file.exportedAt ?? ''),
    catalogBuild: typeof file.catalogBuild === 'string' ? file.catalogBuild : null, world, entities,
  };
}

function sanitizeEntity(raw: Partial<Entity>, worldId: string, tagIds: Set<string>, defs: Map<string, FieldDef>): Entity | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ENTITY_KINDS.includes(raw.kind as EntityKind)) return null;
  const a = raw.anchor as Partial<StarAnchor> | null | undefined;
  const anchor: StarAnchor | null = a && Array.isArray(a.ids) && a.ids.length
    ? {
      ids: a.ids.map(String), catalogBuild: String(a.catalogBuild ?? ''), index: Number.isInteger(a.index) ? a.index! : -1,
      ra: num(a.ra, NaN), dec: num(a.dec, NaN), dist: num(a.dist, NaN), label: String(a.label ?? a.ids[0]),
    }
    : null;
  if (raw.kind === 'star' && !anchor) return null; // phase 1: star entities are annotations
  const fields: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(raw.fields ?? {})) {
    const d = defs.get(k);
    const c = d ? coerceValue(d, v) : undefined;
    if (c !== undefined) fields[k] = c;
  }
  return {
    id: raw.id, worldId, kind: raw.kind as EntityKind, anchor, name: String(raw.name ?? ''),
    description: String(raw.description ?? ''), tags: [...new Set((raw.tags ?? []).filter((t) => tagIds.has(t)))],
    fields, createdAt: num(raw.createdAt, Date.now()), updatedAt: num(raw.updatedAt, Date.now()),
    rev: Number.isInteger(raw.rev) && raw.rev! > 0 ? raw.rev! : 1,
  };
}

export function buildWorldFile(world: WorldMeta, entities: Entity[], catalogBuild: string | null): WorldFile {
  return {
    format: WORLD_FILE_FORMAT, formatVersion: WORLD_SCHEMA_VERSION, exportedAt: new Date().toISOString(),
    catalogBuild, world: structuredClone(world), entities: entities.map((e) => structuredClone(e)),
  };
}

/** Gives a file's world and entities fresh ids (for "import as copy" and "duplicate"). */
export function cloneWithNewIds(file: WorldFile, name?: string): WorldFile {
  const world = { ...structuredClone(file.world), id: newId('world'), name: name ?? `${file.world.name} (cópia)`, createdAt: Date.now(), updatedAt: Date.now() };
  const entities = file.entities.map((e) => ({ ...structuredClone(e), id: newId(), worldId: world.id }));
  return { ...file, world, entities };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);
function dedupeBy<T>(arr: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return arr.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}
