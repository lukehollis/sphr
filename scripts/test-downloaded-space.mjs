import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const target = specifier.slice(2), json = target.endsWith('.json');
      return next(new URL(`../${target}${json ? '' : '.ts'}`, import.meta.url).href,
        json ? { ...context, importAttributes: { type: 'json' } } : context);
    }
    return next(specifier, context);
  },
  load(url, context, next) { return next(url, url.endsWith('.json') ? { ...context, importAttributes: { type: 'json' } } : context); }
});
const { withConfigBase } = await import('../lib/hosted-assets.ts');
const { loadBootstrapData } = await import('../lib/bootstrap.ts');

const config = 'https://files.example.com/spaces/example-space/bootstrap.json';
const folder = 'https://files.example.com/spaces/example-space/';
// The paths "Download everything" writes in a space's folder (lib/server/space-export.ts).
const files = ['faces/0a1b2c3d4e5f/face0.jpg', 'pano/0a1b2c3d4e5f.jpg', 'mesh/example-space-50k.glb', 'splat/example-space.ply',
  'model/example-space.glb', 'preview.jpg', 'tour-files/0123456789ab/0123456789abcdef.glb', 'faces/Hall_(north)/face5.jpg'];
// Text, addresses and site paths that stay as they are.
const kept = ['mesh/structure', 'Faces of the pyramid', 'faces/', 'faces/0a1b2c3d4e5f', 'faces/a b/face0.jpg', 'Open mesh/example.glb in Blender',
  'preview.jpg is the cover', 'Preview.jpg', 'notes/plan.jpg', 'audio/clip.mp3', './mesh/example.glb', 'https://images.example.org/mesh/photo.jpg',
  '//other.example/faces/a/face0.jpg', '/datasets/matterport/example-space/faces/a/face0.jpg', '/demo/garden_demo.spark.splat',
  '/api/tour-files/0123456789ab/0123456789abcdef.glb', 'data:image/png;base64,AAAA', ''];

test('paths in a downloaded space\'s folders become addresses beside its scene file', () => {
  assert.deepEqual(withConfigBase(files, config), files.map((file) => folder + file));
  assert.equal(withConfigBase('faces/a/face0.jpg', 'http://localhost:8080/example-space/bootstrap.json?v=2'),
    'http://localhost:8080/example-space/faces/a/face0.jpg');
  assert.equal(withConfigBase('mesh/espace-été.glb', config), `${folder}mesh/espace-%C3%A9t%C3%A9.glb`);
});

test('prose, absolute addresses and site paths are never changed', () => {
  assert.deepEqual(withConfigBase(kept, config), kept);
  const value = { position: { x: 1, y: 1.6, z: -2 }, visible: true, fov: null, ids: [3, 'a'] };
  assert.deepEqual(withConfigBase(value, config), value);
});

const download = () => ({
  space: { id: 'example', title: 'Example space', mesh: 'mesh/example-space-50k.glb', thumbnail: 'preview.jpg',
    space_data: { initialNode: 'a', nodes: [{ uuid: 'a', faces: [0, 1, 2, 3, 4, 5].map((face) => `faces/a/face${face}.jpg`), position: { x: 0, y: 1.6, z: 0 } }],
      tags: [{ id: 't1', title: 'mesh/structure', description: 'Open mesh/example-space-50k.glb in Blender, or see preview.jpg.',
        media: { url: 'https://images.example.org/photo.jpg' } }] } },
  tour: { title: 'Example space', tour_data: { mode: 'explore', sceneGraph: [{ id: 'capture-mesh', type: 'model', file: 'mesh/example-space-50k.glb' }] } },
  ui: { loadingImage: 'preview.jpg', note: '/datasets/matterport/example/preview.jpg' }
});

let restore = () => {};
function serve(pageUrl, body, finalUrl = '') {
  const before = { window: globalThis.window, fetch: globalThis.fetch };
  const requested = [];
  const page = new URL(pageUrl);
  globalThis.window = { location: { href: page.href, search: page.search } };
  globalThis.fetch = async (url) => { requested.push(url); return { ok: true, url: finalUrl, json: async () => body }; };
  restore = () => { globalThis.window = before.window; globalThis.fetch = before.fetch; };
  return requested;
}
afterEach(() => restore());

test('?config with a downloaded space opens its files from the folder the config is in', async () => {
  const requested = serve(`http://localhost:3000/?config=${encodeURIComponent(config)}`, download());
  const data = await loadBootstrapData();
  assert.deepEqual(requested, [config]);
  assert.equal(data.space.mesh, `${folder}mesh/example-space-50k.glb`);
  assert.equal(data.space.thumbnail, `${folder}preview.jpg`);
  assert.deepEqual(data.space.space_data.nodes[0].faces, [0, 1, 2, 3, 4, 5].map((face) => `${folder}faces/a/face${face}.jpg`));
  assert.equal(data.tour.tour_data.sceneGraph[0].file, `${folder}mesh/example-space-50k.glb`);
  assert.equal(data.ui.loadingImage, `${folder}preview.jpg`);
  assert.deepEqual(data.space.space_data.tags, download().space.space_data.tags);
  assert.equal(data.ui.note, '/datasets/matterport/example/preview.jpg');
  assert.deepEqual(data.space.space_data.nodes[0].position, { x: 0, y: 1.6, z: 0 });
});

test('a config on the viewer\'s own host, or one that was redirected, resolves against where it was read', async () => {
  serve('http://localhost:3000/?config=/downloads/example-space/bootstrap.json', download());
  assert.equal((await loadBootstrapData()).space.mesh, 'http://localhost:3000/downloads/example-space/mesh/example-space-50k.glb');
  serve('http://localhost:3000/s/x/y', download(), 'https://cdn.example.net/kept/example-space/bootstrap.json');
  assert.equal((await loadBootstrapData('https://files.example.com/example-space')).space.mesh,
    'https://cdn.example.net/kept/example-space/mesh/example-space-50k.glb');
});

test('a published scene file with absolute addresses is read as before', async () => {
  const published = 'https://storage.example.com/scenes/aaaaaaaaaaaa/0123456789abcdef/';
  const body = { space: { id: 'p', title: 'Published', mesh: `${published}mesh/p-50k.glb`,
    space_data: { nodes: [{ uuid: 'a', faces: [`${published}faces/a/face0.jpg`] }] } }, ui: { loadingImage: '/datasets/matterport/p/preview.jpg' } };
  serve(`http://localhost:3000/?config=${published}bootstrap.json`, body);
  const data = await loadBootstrapData();
  assert.equal(data.space.mesh, body.space.mesh);
  assert.deepEqual(data.space.space_data.nodes[0].faces, body.space.space_data.nodes[0].faces);
  assert.equal(data.ui.loadingImage, body.ui.loadingImage);
});
