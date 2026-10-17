import type { Entity, WorldMeta } from './model.ts';

/** Storage backend for worlds. IndexedDB in the browser; in-memory for tests or as a fallback. */
export interface WorldRepo {
  readonly persistent: boolean;
  listWorlds(): Promise<WorldMeta[]>;
  putWorld(w: WorldMeta): Promise<void>;
  deleteWorld(id: string): Promise<void>; // also deletes its entities
  loadEntities(worldId: string): Promise<Entity[]>;
  /** Writes and deletes in one transaction. */
  commit(worldId: string, put: Entity[], del: string[]): Promise<void>;
  /** Replaces a whole world atomically (import "replace"). */
  replaceWorld(w: WorldMeta, entities: Entity[]): Promise<void>;
}

export class MemoryRepo implements WorldRepo {
  readonly persistent = false;
  private worlds = new Map<string, WorldMeta>();
  private entities = new Map<string, Map<string, Entity>>();

  async listWorlds() {
    return [...this.worlds.values()].map((w) => structuredClone(w));
  }
  async putWorld(w: WorldMeta) {
    this.worlds.set(w.id, structuredClone(w));
  }
  async deleteWorld(id: string) {
    this.worlds.delete(id);
    this.entities.delete(id);
  }
  async loadEntities(worldId: string) {
    return [...(this.entities.get(worldId)?.values() ?? [])].map((e) => structuredClone(e));
  }
  async commit(worldId: string, put: Entity[], del: string[]) {
    const m = this.entities.get(worldId) ?? new Map<string, Entity>();
    for (const e of put) m.set(e.id, structuredClone(e));
    for (const id of del) m.delete(id);
    this.entities.set(worldId, m);
  }
  async replaceWorld(w: WorldMeta, entities: Entity[]) {
    this.worlds.set(w.id, structuredClone(w));
    this.entities.set(w.id, new Map(entities.map((e) => [e.id, structuredClone(e)])));
  }
}

const DB_NAME = 'galactic-atlas';
const DB_VERSION = 1;

/** IndexedDB backend. Entities are keyed by [worldId, id] so copies of a world can keep entity ids. */
export class IdbRepo implements WorldRepo {
  readonly persistent = true;
  private db: IDBDatabase;
  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static open(): Promise<IdbRepo> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('entities')) {
          const s = db.createObjectStore('entities', { keyPath: ['worldId', 'id'] });
          s.createIndex('worldId', 'worldId');
        }
      };
      req.onsuccess = () => resolve(new IdbRepo(req.result));
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Banco de dados bloqueado por outra aba.'));
    });
  }

  private tx<T>(stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => T): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(stores, mode);
      let out: T;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('Transação abortada'));
      out = run(t);
    });
  }

  listWorlds(): Promise<WorldMeta[]> {
    let req: IDBRequest<WorldMeta[]>;
    return this.tx(['worlds'], 'readonly', (t) => (req = t.objectStore('worlds').getAll())).then(() => req.result);
  }

  putWorld(w: WorldMeta): Promise<void> {
    return this.tx(['worlds'], 'readwrite', (t) => void t.objectStore('worlds').put(w));
  }

  deleteWorld(id: string): Promise<void> {
    return this.tx(['worlds', 'entities'], 'readwrite', (t) => {
      t.objectStore('worlds').delete(id);
      t.objectStore('entities').delete(IDBKeyRange.bound([id], [id, []]));
    });
  }

  loadEntities(worldId: string): Promise<Entity[]> {
    let req: IDBRequest<Entity[]>;
    return this.tx(['entities'], 'readonly', (t) => (req = t.objectStore('entities').index('worldId').getAll(worldId)))
      .then(() => req.result);
  }

  commit(worldId: string, put: Entity[], del: string[]): Promise<void> {
    return this.tx(['entities'], 'readwrite', (t) => {
      const s = t.objectStore('entities');
      for (const e of put) s.put(e);
      for (const id of del) s.delete([worldId, id]);
    });
  }

  replaceWorld(w: WorldMeta, entities: Entity[]): Promise<void> {
    return this.tx(['worlds', 'entities'], 'readwrite', (t) => {
      t.objectStore('worlds').put(w);
      const s = t.objectStore('entities');
      s.delete(IDBKeyRange.bound([w.id], [w.id, []]));
      for (const e of entities) s.put(e);
    });
  }
}

/**
 * Opens IndexedDB in the background and delegates to it; falls back to memory (with
 * `persistent = false`) when IndexedDB is unavailable, e.g. some private-browsing modes.
 */
export class LazyRepo implements WorldRepo {
  private inner: WorldRepo | null = null;
  private ready: Promise<WorldRepo>;

  constructor(open: () => Promise<WorldRepo>) {
    this.ready = open().catch((err) => {
      console.warn('IndexedDB unavailable, world data will not persist:', err);
      return new MemoryRepo();
    }).then((r) => (this.inner = r));
  }

  get persistent(): boolean {
    return this.inner?.persistent ?? true;
  }

  async listWorlds() { return (await this.ready).listWorlds(); }
  async putWorld(w: WorldMeta) { return (await this.ready).putWorld(w); }
  async deleteWorld(id: string) { return (await this.ready).deleteWorld(id); }
  async loadEntities(worldId: string) { return (await this.ready).loadEntities(worldId); }
  async commit(worldId: string, put: Entity[], del: string[]) { return (await this.ready).commit(worldId, put, del); }
  async replaceWorld(w: WorldMeta, entities: Entity[]) { return (await this.ready).replaceWorld(w, entities); }
}
