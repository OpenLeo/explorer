import test from 'node:test';
import assert from 'node:assert/strict';
import { textHash, appFiles, fingerprint, changedFiles } from '../js/core/appupdate.js';

test('app files: own code and styles only, page included', () => {
  const page = 'https://example.org/explorer/?url=https://example.org/PSA-RE/&only#/frames/AEE2004.full';
  const files = appFiles([
    'https://example.org/explorer/js/app.js',
    'https://example.org/explorer/js/core/repo.js',
    'https://example.org/explorer/css/app.css',
    'https://example.org/explorer/vendor/js-yaml.mjs',
    'https://example.org/PSA-RE/buses/AEE2004.full/HS.IS/0B6.yml',
    'https://example.org/explorer/data/manifest.json',
    'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.mjs',
    'https://raw.githubusercontent.com/prototux/PSA-RE/master/architectures.yml',
    'not a url ::',
  ], page);
  assert.deepEqual(files, [
    'https://example.org/explorer/?url=https://example.org/PSA-RE/&only',
    'https://example.org/explorer/css/app.css',
    'https://example.org/explorer/js/app.js',
    'https://example.org/explorer/js/core/repo.js',
    'https://example.org/explorer/vendor/js-yaml.mjs',
  ]);
});

test('fingerprints detect changed files, ignore unreadable ones', async () => {
  const v1 = { a: 'export const x = 1;', b: 'body {}', c: 'old' };
  const v2 = { a: 'export const x = 2;', b: 'body {}' };
  const read = (v) => async (u) => { if (!(u in v)) throw new Error('404'); return v[u]; };
  const run = await fingerprint(['a', 'b', 'c'], read(v1));
  const same = await fingerprint(['a', 'b', 'c'], read(v1));
  const next = await fingerprint(['a', 'b', 'c'], read(v2));
  assert.equal(run.hash, same.hash);
  assert.deepEqual(changedFiles(run, same), []);
  assert.notEqual(run.hash, next.hash);
  assert.deepEqual(changedFiles(run, next), ['a'], 'c could not be read: not reported');
  assert.equal(textHash(''), '811c9dc5');
  assert.notEqual(textHash('a'), textHash('b'));
});
