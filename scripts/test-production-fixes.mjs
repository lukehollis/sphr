import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import sharp from 'sharp';

const notices = [];
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const target = specifier.slice(2);
      return next(new URL(`../${target}.ts`, import.meta.url).href, context);
    }
    if (specifier === './AccountAuth' && context.parentURL?.endsWith('/components/uploads.ts')) {
      return { shortCircuit: true, url: 'file:///stub/AccountAuth.mjs' };
    }
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL?.endsWith('.ts')) {
      return next(specifier + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('/lib/server/analytics-store.ts')) {
      return { format: 'module', shortCircuit: true, source: 'export function saveEvent() {}' };
    }
    if (url.endsWith('/lib/server/team-notify.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export async function notifyTeam(event) { globalThis.__testNotices.push(event); }'
      };
    }
    if (url === 'file:///stub/AccountAuth.mjs') {
      return { format: 'module', shortCircuit: true, source: 'export async function accountRequest() {}' };
    }
    return next(url, context);
  }
});
globalThis.__testNotices = notices;

const { isSameOriginUrl, navigateContinue } = await import('../lib/same-origin.ts');
const { TextureCache } = await import('../lib/three/TextureCache.ts');
const { reportClientError } = await import('../lib/server/error-report.ts');
const { titleFromFiles } = await import('../components/uploads.ts');
const { buildPanoramas, cleanPanoramaLabel } = await import('./packages/build-panoramas.mjs');
const { validatePackage } = await import('./packages/validate-package.mjs');

test('cross-origin VR continue sets top.location.href without reading cross-origin Location.assign', () => {
  assert.equal(isSameOriginUrl('https://app.spacery.dev/s/abc/next', 'https://app.spacery.dev/s/abc/now'), true);
  assert.equal(isSameOriginUrl('/s/abc/next', 'https://app.spacery.dev/s/abc/now'), true);
  assert.equal(isSameOriginUrl('https://mused.com/guided/266/', 'https://app.spacery.dev/s/abc/now'), false);
  assert.equal(isSameOriginUrl('data:text/html,hi', 'data:text/html,there'), false, 'opaque null origins never match');

  let topHref = '';
  const crossOriginTop = {
    location: {
      get assign() {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
      },
      get href() {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
      },
      set href(value) {
        topHref = value;
      }
    }
  };
  let selfAssigned = '';
  const framedWindow = {
    location: { href: 'https://app.spacery.dev/s/ffa3cb6c9d16/meresankh', assign(value) { selfAssigned = value; } },
    top: crossOriginTop
  };
  navigateContinue('https://mused.com/guided/next/', framedWindow);
  assert.equal(topHref, 'https://mused.com/guided/next/');
  assert.equal(selfAssigned, '');

  navigateContinue('/s/next00000000/room', framedWindow);
  assert.equal(selfAssigned, 'https://app.spacery.dev/s/next00000000/room');
});

test('TextureCache caps oversized equirectangular panoramas to maxSize before uploading to WebGL', async t => {
  const priorDocument = globalThis.document;
  const drawn = [];
  globalThis.document = {
    createElementNS: () => {
      const listeners = {};
      return {
        addEventListener(type, fn) { listeners[type] = fn; },
        removeEventListener(type) { delete listeners[type]; },
        set src(url) {
          setImmediate(() => {
            this.naturalWidth = 8192;
            this.naturalHeight = 4096;
            this.width = 8192;
            this.height = 4096;
            listeners.load?.({});
          });
        }
      };
    },
    createElement: tag => {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            imageSmoothingQuality: 'low',
            drawImage(_img, _x, _y, w, h) { drawn.push([w, h]); }
          };
        }
      };
    }
  };
  t.after(() => { globalThis.document = priorDocument; });
  const cache = new TextureCache(undefined, 64 * 1024 * 1024, false, 4096);
  const texture = await cache.loadAsync('/pano/001.jpg');
  assert.deepEqual(drawn, [[4096, 2048]]);
  assert.equal(texture.image.width, 4096);
  assert.equal(texture.image.height, 2048);
  cache.dispose();
});

test('reportClientError drops unactionable visitor network aborts while keeping HTTP asset errors and deduplicating WebGL loops', () => {
  notices.length = 0;
  // Unactionable client network drops stay quiet on Discord.
  reportClientError({ kind: 'startup', message: 'TypeError: Load failed' }, 'app.spacery.dev/s/1', 'Phone, Safari');
  reportClientError({ kind: 'startup', message: 'TypeError: Failed to fetch' }, 'app.spacery.dev/s/1', 'Desktop, Chrome');
  reportClientError({ kind: 'startup', message: 'TypeError: network error' }, 'app.spacery.dev/', 'Desktop, Chrome');
  reportClientError({ kind: 'startup', message: 'Error: Unable to load the panorama at scan-526' }, 'app.spacery.dev/s/1', 'Desktop, Chrome');
  reportClientError({ kind: 'load', message: 'ChunkLoadError: Failed to load /_next/static/chunks/a.css', source: 'still failing after a reload', detail: 'fetch failed: Load failed' }, 'app.spacery.dev/s/1', 'Desktop, Safari');
  reportClientError({ kind: 'load', message: 'ChunkLoadError: Failed to load /_next/static/chunks/a.js', source: 'still failing after a reload', detail: 'no answer in 8 s' }, 'app.spacery.dev/s/1', 'Desktop, Safari');
  reportClientError({ kind: 'reconstruction', message: 'Error: The reconstruction did not load', source: 'still loading after 20 s' }, 'app.spacery.dev/s/1', 'Desktop, Firefox');
  reportClientError({ kind: 'reconstruction', message: 'Error: The reconstruction did not load', source: 'failed: Load failed' }, 'app.spacery.dev/s/1', 'Phone, Safari');
  assert.equal(notices.length, 0);

  // Real HTTP 4xx/5xx failures and WebGL loops still page, and loop + loop-at-start deduplicate.
  reportClientError({ kind: 'startup', message: 'Error: Failed to load config https://static.mused.com/bootstrap.json: 403' }, 'app.spacery.dev/s/1', 'Phone, Chrome');
  reportClientError({ kind: 'startup', message: 'Error: Unable to load the panorama at scan-526 (HTTP 404)' }, 'app.spacery.dev/s/1', 'Desktop, Chrome');
  reportClientError({ kind: 'load', message: 'ChunkLoadError: Failed to load /_next/static/chunks/core.js', source: 'still failing after a reload', detail: 'HTTP 403 text/html Zscaler/6.2: Website blocked' }, 'app.spacery.dev/s/1', 'Desktop, Chrome');
  reportClientError({ kind: 'reconstruction', message: 'Error: The reconstruction did not load', source: 'failed: The manifest returned HTTP 404.' }, 'app.spacery.dev/s/1', 'Desktop, Chrome');
  reportClientError({ kind: 'webgl', message: 'Error: WebGL context lost in a loop at start', source: '0 textures, Apple GPU' }, 'app.spacery.dev/s/1', 'Desktop, Safari');
  reportClientError({ kind: 'webgl', message: 'Error: WebGL context lost in a loop', source: '0 textures, Apple GPU' }, 'app.spacery.dev/s/1', 'Desktop, Safari');
  assert.equal(notices.length, 5);
});

test('titleFromFiles avoids naming multi-photo uploads after whichever JPEG compressed slightly larger', () => {
  const f = (name, size, rel = name) => ({ file: { name, size }, path: rel });
  const nov14 = new Date('2026-11-14T18:00:00Z');
  assert.match(titleFromFiles([
    f('01-Entrance.JPG', 4_100_000),
    f('02-living-room.JPG', 4_200_000),
    f('03-diner.JPG', 4_500_000),
    f('04-TV-room.JPG', 3_900_000),
    f('05-bath1.JPG', 3_800_000)
  ], nov14), /^Capture from /);
  assert.equal(titleFromFiles([f('kitchen.obj', 25_000_000), f('kitchen.mtl', 2_000), f('wood.jpg', 800_000)], nov14), 'Kitchen');
  assert.equal(titleFromFiles([f('villa_01.jpg', 4_000_000), f('villa_02.jpg', 4_200_000)], nov14), 'Villa');
  assert.equal(titleFromFiles([f('03-diner.JPG', 4_500_000)], nov14), '03 diner');
});

test('buildPanoramas cleans numbered captions, places floor pucks on the floor, and turns away from a blank center wall', async () => {
  assert.equal(cleanPanoramaLabel('01-Entrance.JPG'), 'Entrance');
  assert.equal(cleanPanoramaLabel('02-living-room.JPG'), 'Living room');
  assert.equal(cleanPanoramaLabel('04-TV-room.JPG'), 'TV room');

  const work = mkdtempSync(path.join(tmpdir(), 'sphr-pano-test-'));
  try {
    // Photo 1: flat beige center (x = 120..280 of 400), checkerboard detail on the right side (x = 280..360 -> x_human ~ 0.8 -> negative azimuth).
    const w = 400, h = 200;
    const pixels = Buffer.alloc(w * h * 3, 210);
    for (let y = 40; y < 160; y++) {
      for (let x = 280; x < 360; x++) {
        const checker = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2) === 0 ? 25 : 240;
        const idx = (y * w + x) * 3;
        pixels[idx] = checker; pixels[idx + 1] = 255 - checker; pixels[idx + 2] = checker;
      }
    }
    const img1 = path.join(work, '01-Entrance.jpg');
    const img2 = path.join(work, '02-living-room.jpg');
    await sharp(pixels, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toFile(img1);
    await sharp(pixels, { raw: { width: w, height: h, channels: 3 } }).flop().jpeg({ quality: 92 }).toFile(img2);

    const folder = path.join(work, 'out', 'public', 'datasets', 'matterport', 'customer-test');
    const id = { sceneId: '0123456789ab', slug: 'customer-test', title: 'Home Tour', datasetUrl: '/datasets/matterport/customer-test', folder };
    const { used } = await buildPanoramas([img1, img2], id, { captions: true });
    assert.equal(used.length, 2);
    assert.notEqual(used[0].azimuth, 0, 'turns away from the blank center wall');
    assert.deepEqual(used.map(item => item.label), ['Entrance', 'Living room']);
    const check = validatePackage(folder, { sceneId: '0123456789ab', slug: 'customer-test', title: 'Home Tour' });
    assert.equal(check.passed, true, check.errors.join(', '));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
