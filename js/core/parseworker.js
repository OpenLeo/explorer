// Parse worker: YAML files parsed off the main thread (same parseOne as the main thread and the bundle builder).
import * as jsyaml from '../../vendor/js-yaml.mjs';
import { setYamlLib } from './yamlparse.js';
import { parseOne } from './sources.js';

setYamlLib(jsyaml);

self.onmessage = (ev) => {
  const { id, items } = ev.data;
  try {
    const out = items.map((it) => parseOne(it.path, it.bytes));
    self.postMessage({ id, out });
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
