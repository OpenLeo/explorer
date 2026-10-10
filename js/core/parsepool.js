// Pool of parse workers (browser). parse(items) -> parsed items in the same order; throws if workers are unavailable
// (the caller then parses on the main thread).

export function createParsePool(size) {
  if (typeof Worker === 'undefined') return null;
  const n = Math.max(1, Math.min(size || 2, 6));
  let workers = null;
  let seq = 0;
  const waiting = new Map();

  function start() {
    if (workers) return workers;
    workers = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./parseworker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => {
        const p = waiting.get(ev.data.id);
        if (!p) return;
        waiting.delete(ev.data.id);
        if (ev.data.error) p.reject(new Error(ev.data.error)); else p.resolve(ev.data.out);
      };
      w.onerror = (ev) => {
        // module workers unsupported or the worker failed to load: fail every pending job of this worker
        for (const [id, p] of waiting) if (p.worker === w) { waiting.delete(id); p.reject(new Error(ev.message || 'worker error')); }
      };
      workers.push(w);
    }
    return workers;
  }

  function run(w, items) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject, worker: w });
      w.postMessage({ id, items });   // copied, not transferred: the caller may still parse them itself
    });
  }

  return async function parse(items) {
    const ws = start();
    // split by size so the workers finish together, keep the order
    const chunks = ws.map(() => ({ items: [], idx: [], bytes: 0 }));
    const order = items.map((it, i) => i).sort((a, b) => items[b].bytes.length - items[a].bytes.length);
    for (const i of order) {
      const c = chunks.reduce((m, x) => (x.bytes < m.bytes ? x : m), chunks[0]);
      c.items.push(items[i]); c.idx.push(i); c.bytes += items[i].bytes.length;
    }
    const results = await Promise.all(chunks.map((c, k) => (c.items.length ? run(ws[k], c.items) : [])));
    const out = new Array(items.length);
    chunks.forEach((c, k) => c.idx.forEach((i, j) => { out[i] = results[k][j]; }));
    return out;
  };
}
