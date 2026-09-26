// Global application state shared by the views.

import { store } from '../core/cache.js';
import { DEFAULT_SOURCE, sourceDefaults } from '../core/sources.js';

export const app = {
  db: null,
  loading: false,
  loadErrors: [],
  sourceNotes: [],
  settings: {
    lang: store.get('lang', 'en'),
    theme: store.get('theme', 'auto'),
    token: store.get('token', ''),
    sources: (store.get('sources', null) || [DEFAULT_SOURCE]).map((s, i) => sourceDefaults(s, i)),
  },
  localHandles: new Map(), // source id -> {fileList | dirHandle} (not persisted)
  listeners: new Set(),
  route: null,
};

export function saveSettings() {
  const s = app.settings;
  store.set('lang', s.lang);
  store.set('theme', s.theme);
  store.set('token', s.token);
  store.set('sources', s.sources.map((x) => {
    const { dirHandle, fileList, ...rest } = x;
    return rest;
  }));
}

export function lang() { return app.settings.lang || 'en'; }

export function sourceMetaById(id) {
  return (app.db && app.db.sourceById.get(id)) || app.settings.sources.find((s) => s.id === id) || { id, label: id, color: '#888' };
}

export function onChange(fn) { app.listeners.add(fn); return () => app.listeners.delete(fn); }
export function emit(ev) { for (const fn of app.listeners) { try { fn(ev); } catch (e) { console.warn(e); } } }
