// Links and embed codes that open a space at a view (lib/share-link.ts).
//   node --test scripts/test-share-link.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { embedCode, readLinkEntry, shareUrl } from '../lib/share-link.ts';

const base = 'https://app.spacery.dev/s/619ad80511a1/go-inside-the-great-pyramid-of-giza';
const read = (url, space = { nodes: ['pano-1', 'pano-2'], stops: 4, free: false }) => readLinkEntry(new URL(url).searchParams, space);

test('a link carries the panorama, the way it faces and the zoom, and opens there again', () => {
  const url = shareUrl(`${base}?old=1#x`, { nodeId: 'pano-2', rotation: { azimuth: 95.234, polar: -19.06 }, fov: 61.6 });
  assert.equal(url, `${base}?at=pano-2&look=95.2,-19.1&fov=62`);
  assert.deepEqual(read(url), { view: { nodeId: 'pano-2', rotation: { azimuth: 95.2, polar: -19.1 }, fov: 62 } });
});

test('a space without panoramas carries where the camera stood', () => {
  const url = shareUrl(base, { position: { x: 1.23456, y: 1.6, z: -3 }, rotation: { azimuth: -40, polar: 5 }, fov: 75 });
  assert.equal(url, `${base}?pos=1.23,1.6,-3&look=-40,5&fov=75`);
  assert.deepEqual(read(url, { nodes: [], stops: 1, free: true }), { view: { position: { x: 1.23, y: 1.6, z: -3 }, rotation: { azimuth: -40, polar: 5 }, fov: 75 } });
  assert.deepEqual(read(url), {}, 'a space with panoramas opens at a panorama, never at a loose position');
});

test('a tour stop, hidden tags and the whole space', () => {
  assert.equal(shareUrl(base, { stop: 2 }), `${base}?stop=3`);
  assert.deepEqual(read(`${base}?stop=3`), { stop: 2 });
  assert.equal(shareUrl(base, null, { tags: false }), `${base}?tags=0`);
  assert.equal(shareUrl(base, null), base);
});

test('links that ask for something else open as usual', () => {
  for (const url of [`${base}?at=missing`, `${base}?stop=9`, `${base}?stop=0`, `${base}?pos=1,2`, `${base}?pos=1,x,3`]) {
    assert.deepEqual(read(url, { nodes: ['pano-1'], stops: 4, free: true }), {}, url);
  }
  const tilted = read(`${base}?at=pano-1&look=10,120&fov=500`);
  assert.deepEqual(tilted, { view: { nodeId: 'pano-1', rotation: { azimuth: 10, polar: 89 } } }, 'tilt is clamped and an impossible zoom is dropped');
});

test('the embed code is an iframe that may go full screen and into a headset, with its attributes escaped', () => {
  const code = embedCode(`${base}?at=pano-1&look=1,2`, 'Tom & Jerry "house"');
  assert.match(code, /^<iframe src="https:\/\/app\.spacery\.dev\/s\/619ad80511a1\/go-inside-the-great-pyramid-of-giza\?at=pano-1&amp;look=1,2" /);
  assert.match(code, /title="Tom &amp; Jerry &quot;house&quot;"/);
  assert.match(code, /allow="fullscreen; xr-spatial-tracking; accelerometer; gyroscope; autoplay" allowfullscreen loading="lazy"><\/iframe>$/);
});
