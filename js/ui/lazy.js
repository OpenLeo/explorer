// Diagnostic data loaded on demand: run a loader, save what it loaded in the source caches, re-render the view
// that asked for it if it is still displayed.

import { app, emit } from './state.js';
import { saveSourceCache } from '../core/sources.js';
import { idbCache } from '../core/cache.js';
import { debounce } from '../core/util.js';

const saveCaches = debounce(() => {
  for (const s of app.loadedSources || []) saveSourceCache(idbCache, s);
}, 3000);

/** stillHere(route) -> true when the current route is still the page that asked */
export function afterLoad(promise, stillHere) {
  return Promise.resolve(promise).then((n) => {
    if (!n) return n;
    saveCaches();
    emit({ type: 'diag' });
    if (app.route && stillHere(app.route) && app.rerender) app.rerender();
    return n;
  }).catch((e) => { console.warn('diag loading failed', e); });
}
