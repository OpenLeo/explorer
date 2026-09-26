// Cross-architecture signal catalogue.
// A signal is grouped by its exact normalized name; frame ID is deliberately irrelevant.

import { naturalCompare } from './util.js';

/**
 * Build groups shaped as:
 * {name, aliases[], architectures[], frameIds[], occurrences:[{archvar, frame, signal, inherited}]}
 *
 * Effective variant frame sets are used, so an inherited frame is listed for every
 * architecture variant in which it is available. Only primary-source frames occur in
 * variantFrames; alternate source versions remain available through the frame source switch.
 */
export function buildSignalCatalog(db, opts = {}) {
  const groups = new Map();
  const includeUnused = opts.includeUnused === true;
  for (const [archvar, frames] of (db && db.variantFrames) || []) {
    for (const frame of frames) {
      for (const signal of frame.signals || []) {
        if (!signal || !signal.name || (!includeUnused && signal.unused)) continue;
        let g = groups.get(signal.name);
        if (!g) {
          g = { name: signal.name, aliases: new Set(), architectures: new Set(), frameIds: new Set(), occurrences: [] };
          groups.set(signal.name, g);
        }
        for (const a of signal.altNames || []) g.aliases.add(a);
        g.architectures.add(archvar);
        g.frameIds.add(frame.id);
        g.occurrences.push({ archvar, frame, signal, inherited: frame.archvar !== archvar });
      }
    }
  }
  return [...groups.values()].map((g) => ({
    name: g.name,
    aliases: [...g.aliases].sort(naturalCompare),
    architectures: [...g.architectures].sort(naturalCompare),
    frameIds: [...g.frameIds].sort((a, b) => a - b),
    occurrences: g.occurrences.sort((a, b) => naturalCompare(a.archvar, b.archvar)
      || a.frame.id - b.frame.id || naturalCompare(a.frame.netbus, b.frame.netbus)
      || naturalCompare(a.frame.fileBase, b.frame.fileBase)),
  })).sort((a, b) => naturalCompare(a.name, b.name));
}

