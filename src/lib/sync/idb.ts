/* IndexedDB storage for the browser (idb-keyval). Every database is opened lazily. */
import { clear, createStore, del, get, getMany, keys, set, type UseStore } from 'idb-keyval';
import type { KV, StorageFactory } from './storage.ts';

// async so that a synchronous throw (no IndexedDB at all) becomes a rejection like any other failure
function kv(store: UseStore): KV {
  return {
    get: async (key) => get(key, store),
    getMany: async (ks) => getMany(ks, store),
    set: async (key, value) => set(key, value, store),
    del: async (key) => del(key, store),
    keys: async () => (await keys(store)).map(String),
    clear: async () => clear(store),
  };
}

export function idbStorage(): StorageFactory {
  const open = new Map<string, KV>();
  return {
    open(name, kind) {
      let s = open.get(name);
      if (!s) {
        let store: UseStore | undefined;
        // createStore opens the database on first use only; a failure surfaces per call.
        const lazy = (): UseStore => (store ??= createStore(name, kind));
        s = kv(((mode, cb) => lazy()(mode, cb)) as UseStore);
        open.set(name, s);
      }
      return s;
    },
  };
}
