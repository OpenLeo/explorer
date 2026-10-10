// IndexedDB cache of parsed sources + safe localStorage helpers.
// Every access is wrapped in try/catch: private windows or blocked storage just disable caching.

const DB_NAME = 'openleo-explorer';
const STORE = 'sources';
const FILES = 'files';   // parsed files by content hash (git blob sha), shared by every revision
const VERSION = 2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        for (const name of [STORE, FILES]) {
          try { if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name); } catch (e) { /* exists */ }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(mode, fn, storeName = STORE) {
  return openDb().then((db) => new Promise((resolve) => {
    if (!db) { resolve(null); return; }
    try {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      const req = fn(store);
      t.oncomplete = () => resolve(req ? req.result : null);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  }));
}

export const idbCache = {
  async get(key) { return tx('readonly', (s) => s.get(key)); },
  async set(key, value) {
    // keep only the latest revision per source prefix
    const prefix = key.split('|').slice(0, 2).join('|') + '|';
    try {
      const keys = (await tx('readonly', (s) => s.getAllKeys())) || [];
      for (const k of keys) if (typeof k === 'string' && k.startsWith(prefix) && k !== key) await tx('readwrite', (s) => s.delete(k));
    } catch (e) { /* ignore */ }
    return tx('readwrite', (s) => s.put(value, key));
  },
  async clear() { return tx('readwrite', (s) => s.clear()); },
};

/** Per-file cache: parsed files by content hash. Every file of every revision seen, so an update of a repository
 * only downloads the files that changed. */
export const idbFiles = {
  async getMany(keys) {
    const out = new Map();
    await tx('readonly', (s) => {
      for (const k of keys) {
        const r = s.get(k);
        r.onsuccess = () => { if (r.result !== undefined) out.set(k, r.result); };
      }
      return null;
    }, FILES);
    return out;
  },
  async setMany(pairs) {
    return tx('readwrite', (s) => { for (const [k, v] of pairs) s.put(v, k); return null; }, FILES);
  },
  async clear() { return tx('readwrite', (s) => s.clear(), FILES); },
  /** drop the entries whose key is not in keep (Set): files of revisions no source lists any more */
  async prune(keep) {
    const keys = (await tx('readonly', (s) => s.getAllKeys(), FILES)) || [];
    const old = keys.filter((k) => !keep.has(k));
    if (old.length) await tx('readwrite', (s) => { for (const k of old) s.delete(k); return null; }, FILES);
    return old.length;
  },
};

export const store = {
  get(key, def = null) {
    try {
      const v = localStorage.getItem('openleo-explorer:' + key);
      return v === null ? def : JSON.parse(v);
    } catch (e) { return def; }
  },
  set(key, value) {
    try { localStorage.setItem('openleo-explorer:' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  },
  remove(key) {
    try { localStorage.removeItem('openleo-explorer:' + key); } catch (e) { /* ignore */ }
  },
};
