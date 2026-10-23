/*
 * Storage seams for the sync engine, so it runs in the browser (IndexedDB, localStorage,
 * Web Locks) and in Node tests (in memory) unchanged. No browser globals at load time.
 */

/** An async key-value store (one IndexedDB object store, or a Map in tests). */
export interface KV {
  get<T = unknown>(key: string): Promise<T | undefined>;
  getMany(keys: string[]): Promise<unknown[]>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

/** Opens named stores. Names: `field-desk:<principal>` (state) and `field-desk-photos:<principal>` (photos). */
export interface StorageFactory {
  open(name: string, kind: 'state' | 'photos'): KV;
}

/** Synchronous small settings (localStorage). Every call may throw in the real thing — see safePrefs. */
export interface Prefs {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** Web Locks subset. Absent = one tab only (tests, old browsers). */
export interface Locks {
  request<T>(name: string, options: { mode?: 'exclusive' | 'shared' }, fn: () => Promise<T>): Promise<T>;
  query?(): Promise<{ held?: { name?: string }[] }>;
}

/** localStorage wrapper that never throws (private mode, denied storage, quota). */
export function safePrefs(get: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined): Prefs {
  const mem = new Map<string, string>();
  return {
    get(key) {
      try {
        const v = get()?.getItem(key);
        return v ?? mem.get(key) ?? null;
      } catch {
        return mem.get(key) ?? null;
      }
    },
    set(key, value) {
      mem.set(key, value);
      try {
        get()?.setItem(key, value);
      } catch {
        /* kept in memory for this tab */
      }
    },
    remove(key) {
      mem.delete(key);
      try {
        get()?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** In-memory KV. `fail` makes writes (or everything) reject, to test storage failure paths. */
export class MemoryKV implements KV {
  data = new Map<string, unknown>();
  fail: false | 'writes' | 'all' = false;
  private check(write: boolean) {
    if (this.fail === 'all' || (write && this.fail === 'writes')) {
      const e = new Error('The quota has been exceeded.');
      e.name = 'QuotaExceededError';
      return Promise.reject(e);
    }
    return null;
  }
  async get<T>(key: string) {
    await this.check(false);
    const v = this.data.get(key);
    return (v === undefined ? undefined : structuredCloneIfPlain(v)) as T | undefined;
  }
  async getMany(keys: string[]) {
    await this.check(false);
    return keys.map((k) => structuredCloneIfPlain(this.data.get(k)));
  }
  async set(key: string, value: unknown) {
    await this.check(true);
    this.data.set(key, structuredCloneIfPlain(value));
  }
  async del(key: string) {
    await this.check(true);
    this.data.delete(key);
  }
  async keys() {
    await this.check(false);
    return [...this.data.keys()];
  }
  async clear() {
    await this.check(true);
    this.data.clear();
  }
}

// IndexedDB stores structured clones; Blobs are immutable so they can be shared as is.
const structuredCloneIfPlain = (v: unknown) => (v === undefined || v === null || typeof v !== 'object' || (typeof Blob !== 'undefined' && v instanceof Blob) ? v : structuredClone(v));

/** A factory of MemoryKVs, kept by name so a "reloaded" engine sees the same data. */
export class MemoryStorage implements StorageFactory {
  stores = new Map<string, MemoryKV>();
  open(name: string) {
    let s = this.stores.get(name);
    if (!s) this.stores.set(name, (s = new MemoryKV()));
    return s;
  }
}

/** In-memory Prefs (one "device"). */
export function memoryPrefs(): Prefs & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) };
}
