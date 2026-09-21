import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBundle } from './legacy/extract-bundle.mjs';

test('extracts authored literals without running archived JavaScript', () => {
  const value = { payload: { objects: [{ sweep: 'source-scan', content: 'A story', rotation: { x: 0, y: 10 } }] } };
  const input = `throw new Error('Must never execute'); const points = JSON.parse(${JSON.stringify(JSON.stringify(value))});`;
  assert.deepEqual(extractBundle(input).points, value.payload.objects);
  assert.equal(extractBundle(input).sha256.length, 64);
});

test('rejects executable data expressions and ambiguous tours', () => {
  assert.throws(() => extractBundle('JSON.parse(getTourFromNetwork())'), /found 0/);
  const data = JSON.stringify(JSON.stringify({ payload: { objects: [{ sweep: 'scan', content: 'text' }] } }));
  assert.throws(() => extractBundle(`JSON.parse(${data}); JSON.parse(${data});`), /found 2/);
});
