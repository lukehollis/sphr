import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const path = specifier.slice(2), json = path.endsWith('.json');
      return next(new URL(`../${path}${json ? '' : '.ts'}`, import.meta.url).href, json ? { ...context, importAttributes: { type: 'json' } } : context);
    }
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier + '.ts', context);
    return next(specifier, context);
  },
  load(url, context, next) { return next(url, url.endsWith('.json') ? { ...context, importAttributes: { type: 'json' } } : context); }
});
const { tourSegment, nextTourLocation } = await import('../lib/viewer/segments.ts');
const { parseSceneCatalog } = await import('../lib/scene-catalog-data.ts');
const { legacyDestination } = await import('../lib/legacy-routes.ts');
const { SphrRuntime } = await import('../lib/three/SphrRuntime.ts');
const { AnnotationLayer } = await import('../lib/three/layers/AnnotationLayer.ts');
const { ViewerSession } = await import('../lib/viewer/ViewerSession.ts');
const { defaultBootstrap, normalizeTour } = await import('../lib/bootstrap.ts');
const bootstrap = {
  space: { id: 'a', title: 'First', type: 'spaces', space_data: { nodes: [{ uuid: 'entry' }], sceneGraph: [{ id: 'mesh', type: 'model', persistent: true, raycast: true, file: '/mesh.glb' }] } },
  orderedSpaces: [
    { id: 'a', title: 'First', type: 'spaces', space_data: { nodes: [{ uuid: 'entry' }], sceneGraph: [{ id: 'mesh', type: 'model', persistent: true, raycast: true, file: '/mesh.glb' }] } },
    { id: 'b', title: 'Second', type: 'spaces', space_data: { nodes: [{ uuid: 'sweep' }] } }
  ],
  tour: { tour_data: { mode: 'guided', sceneGraph: [{ id: 'artifact', type: 'model', file: '/object.glb' }], spaces: [
    { id: 'a', tourpoints: [{ nodeUUID: 'entry' }, { targetType: 'MODEL', nodeUUID: 'entry', models: ['artifact'] }, { nodeUUID: 'entry' }] },
    { id: 'b', tourpoints: [{ nodeUUID: 'sweep' }] }
  ] } }
};

test('tour crosses renderer boundaries in both directions and stops at real endpoints', () => {
  assert.deepEqual(nextTourLocation(bootstrap, 0, 2, 1), { spaceIndex: 1, pointIndex: 0 });
  assert.deepEqual(nextTourLocation(bootstrap, 1, 0, -1), { spaceIndex: 0, pointIndex: 2 });
  assert.equal(nextTourLocation(bootstrap, 0, 0, -1), null);
  assert.equal(nextTourLocation(bootstrap, 1, 0, 1), null);
  assert.equal(tourSegment(bootstrap, 1, 0).space.type, 'spaces');
});

test('object stage isolates its model and returning restores the capture', () => {
  const object = tourSegment(bootstrap, 0, 1);
  assert.equal(object.space.type, 'model');
  assert.equal(object.space.space_data.noPanos, true);
  assert.deepEqual(object.space.space_data.sceneGraph.map(x => x.id), ['artifact']);
  assert.notEqual(object.key, tourSegment(bootstrap, 0, 0).key);
  assert.deepEqual(tourSegment(bootstrap, 0, 2).bootstrap.tour.tour_data.sceneGraph.map(x => x.id), ['mesh']);
  assert.equal(object.bootstrap.tour.tour_data.spaces[0].tourpoints.length, 3);
  assert.equal(bootstrap.space.space_data.nodes[0].uuid, 'entry');
});

test('unknown target spaces fail instead of showing the wrong capture', () => {
  const broken = structuredClone(bootstrap); broken.orderedSpaces.pop();
  assert.throws(() => tourSegment(broken, 1, 0), /missing/);
});

test('garden splat scene and authored point order survive the session envelope', () => {
  const garden = defaultBootstrap();
  const stage = tourSegment(garden, 0, 0);
  assert.deepEqual(stage.space.space_data.splats, garden.space.space_data.splats);
  assert.equal(stage.bootstrap.tour.tour_data.spaces[0].tourpoints.length, normalizeTour(garden).spaces[0].tourpoints.length);
  assert.ok(stage.bootstrap.tour.tour_data.sceneGraph.some(x => x.id === 'garden-dollhouse'));
});

const entry = { sceneId: '111111111111', title: 'Example', titleSlug: 'example', scenePath: '/s/111111111111/example', slug: 'space-1',
  bootstrapUrl: '/datasets/legacy/space-1/bootstrap.json', thumbnail: '/datasets/legacy/space-1/preview.jpg', legacy: { kind: 'space', id: '1' } };
test('legacy aliases resolve old slugs to canonical IDs without open redirects', () => {
  const catalog = parseSceneCatalog(JSON.stringify({ spaces: [entry] }));
  assert.equal(legacyDestination(catalog, 'space', '1-an-old-title'), entry.scenePath);
  assert.equal(legacyDestination(catalog, 'tour', '1-an-old-title'), undefined);
  assert.equal(legacyDestination(catalog, 'space', '1/../../evil'), undefined);
  assert.throws(() => parseSceneCatalog(JSON.stringify({ spaces: [{ ...entry, bootstrapUrl: 'https://evil.example/bootstrap.json' }] })), /Invalid/);
  assert.throws(() => parseSceneCatalog(JSON.stringify({ spaces: [entry, { ...entry, sceneId: '222222222222', scenePath: '/s/222222222222/example' }] })), /Duplicate legacy/);
});

test('neutral model pose fits the object on portrait screens and preserves viewing direction', () => {
  const runtime = Object.create(SphrRuntime.prototype);
  runtime.sceneGraph = { getBounds: () => new THREE.Box3(new THREE.Vector3(-1, -3, -1), new THREE.Vector3(1, 3, 1)) };
  runtime.camera = new THREE.PerspectiveCamera(70, .5, .01, 100);
  const point = { targetType: 'MODEL', position: { x: 1, y: 0, z: 1 }, zoom: 0 };
  const pose = runtime.poseForPoint(point, 'ORBIT');
  assert.ok(pose.position.length() > 10);
  assert.ok(Math.abs(pose.position.x - pose.position.z) < 1e-8);
  assert.equal(runtime.poseForPoint({ ...point, zoom: 20 }, 'ORBIT').fov, 50);
  assert.equal(runtime.poseForPoint({ ...point, zoom: 30, fov: 80 }, 'ORBIT').fov, 80);
  assert.equal(runtime.poseForTarget(new THREE.Vector3(), { azimuth: 0, polar: 0 }, 30, 'FPV', 80).fov, 80);
});

test('a hosted space anywhere in a tour is rejected before creating a renderer', async () => {
  for (const index of [0, 1]) {
    for (const hosted of [
      { type: 'matterport' },
      { type: 'spaces', src: 'https://my.matterport.com/show/?m=Example' }
    ]) {
      const source = structuredClone(bootstrap);
      Object.assign(source.orderedSpaces[index], hosted);
      let appended = false;
      const session = new ViewerSession({ append() { appended = true; } }, source, {});
      await assert.rejects(session.init(), /native capture.*Matterport embeds are not supported/);
      assert.equal(appended, false);
    }
  }
  const source = structuredClone(bootstrap);
  source.space.type = 'matterport';
  await assert.rejects(new ViewerSession({}, source, {}).init(), /native capture/);
});

test('video annotation plays only when selected, follows mute and releases its resources', async () => {
  const listeners = new Map(), videos = [], frames = [];
  globalThis.window = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  globalThis.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  globalThis.document = { body: { append() {} }, createElement: () => {
    const video = { dataset: {}, paused: true, play: async function() { this.paused = false; }, pause() { this.paused = true; }, load() {}, removeAttribute() {}, remove() { this.removed = true; } };
    videos.push(video); return video;
  } };
  const scene = new THREE.Scene();
  const layer = new AnnotationLayer(scene, {}, [{ id: 'clip', file: 'https://assets.example.com/clip.mp4', position: [1,2,3] }]);
  layer.init();
  assert.equal(videos[0].paused, true);
  layer.show(['clip']); await Promise.resolve();
  assert.equal(videos[0].paused, false);
  layer.setMuted(true); assert.equal(videos[0].muted, true);
  layer.hideAll(); layer.dispose();
  frames.forEach(fn => fn());
  assert.equal(videos[0].paused, true);
  assert.equal(videos[0].removed, true);
  assert.equal(listeners.size, 0);
  assert.equal(scene.children.length, 0);
});
