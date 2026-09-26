// IndexedDB cache of parsed sources + safe localStorage helpers.
// Every access is wrapped in try/catch: private windows or blocked storage just disable caching.

const DB_NAME = 'openleo-explorer';
const STORE = 'sources';
const VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(STORE); } catch (e) { /* exists */ }
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

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve) => {
    if (!db) { resolve(null); return; }
    try {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
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
