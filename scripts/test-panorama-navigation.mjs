import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from 'three';

// Load the same TypeScript layers used by the viewer. Only browser I/O is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const path = specifier.slice(2);
      const json = path.endsWith('.json');
      return nextResolve(new URL(`../${path}${json ? '' : '.ts'}`, import.meta.url).href,
        json ? { ...context, importAttributes: { type: 'json' } } : context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    return nextLoad(url, url.endsWith('.json') ? { ...context, importAttributes: { type: 'json' } } : context);
  }
});
const { NavigationLayer } = await import('../lib/three/layers/NavigationLayer.ts');
const { PanoramaLayer } = await import('../lib/three/renderers/PanoramaLayer.ts');
const { SphrRuntime } = await import('../lib/three/SphrRuntime.ts');

const scan = (uuid, x, neighbors) => ({
  uuid, position: { x, y: 1.6, z: 0 }, floorPosition: { x, y: 0.025, z: 0 }, neighbors,
  quaternion: [0, 0, 0, 1], faces: Array.from({ length: 6 }, (_, i) => `/panos/${uuid}/${i}.jpg`)
});
const nodes = [scan('entry', 0, ['middle', 'side']), scan('middle', 2, ['entry', 'end']),
  scan('side', -2, ['entry']), scan('end', 4, ['middle'])];
const navigation = { mode: 'neighbors', minVisible: 0, maxVisible: 8, hideActive: true };

function makeCache() {
  const pins = new Map();
  const textures = new Map();
  return {
    pins,
    retain(urls) { for (const url of urls) pins.set(url, (pins.get(url) ?? 0) + 1); },
    release(urls) { for (const url of urls) pins.set(url, pins.get(url) - 1); },
    getReady(url) {
      if (!textures.has(url)) textures.set(url, new THREE.Texture());
      return textures.get(url);
    },
    async loadAsync(url) { return this.getReady(url); },
    trim() {},
    dispose() { for (const texture of textures.values()) texture.dispose(); }
  };
}
const opacity = (scene, uuid) => scene.getObjectByName(`panorama-${uuid}`).children[0].material.opacity;

test('departure pucks remain visible throughout travel without broadening reachable scans', () => {
  const scene = new THREE.Scene();
  const nav = new NavigationLayer(scene, { navigation }, nodes);
  nav.init();
  nav.setActive('entry');
  assert.deepEqual(nav.getDebugSnapshot().renderedNodes, ['middle', 'side']);
  nav.beginTransition();
  nav.setActive('middle');
  assert.equal(nav.group.visible, true);
  assert.deepEqual(nav.getDebugSnapshot().renderedNodes, ['entry', 'middle', 'side', 'end']);
  assert.deepEqual(nav.getNavigableNodes().map(node => node.uuid), ['entry', 'end']);
  nav.group.traverse(child => {
    if (!child.isMesh || child.userData.debugOnly) return;
    assert.ok(child.renderOrder > 10, 'pucks render after the projected photo');
    assert.equal(child.material.depthTest, true, 'real geometry still occludes pucks');
  });
  nav.endTransition();
  assert.deepEqual(nav.getDebugSnapshot().renderedNodes, ['entry', 'end']);
  assert.equal(nav.getDebugSnapshot().transitioning, false);
  nav.dispose();
  assert.deepEqual(nav.getNavigableNodes(), []);
});

test('arrival restores wall occlusion and the destination puck is hidden only at rest', () => {
  const scene = new THREE.Scene();
  const nav = new NavigationLayer(scene, { navigation }, nodes);
  nav.init();
  nav.setActive('entry');
  nav.beginTransition();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(.1, 4, 4), new THREE.MeshBasicMaterial());
  wall.position.set(1, 1.6, 0);
  scene.add(wall);
  nav.setOccluders([wall]);
  nav.setActive('middle');
  assert.ok(nav.getDebugSnapshot().renderedNodes.includes('middle'));
  assert.deepEqual(nav.getNavigableNodes().map(node => node.uuid), ['end']);
  nav.endTransition();
  assert.deepEqual(nav.getDebugSnapshot().renderedNodes, ['end']);
  nav.dispose(); wall.geometry.dispose(); wall.material.dispose();
});

test('projected travel keeps the outgoing photo in mesh gaps until the late handoff', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const scene = new THREE.Scene();
  const captureScene = new THREE.Scene();
  const cache = makeCache();
  const pano = new PanoramaLayer(scene, cache);
  const camera = new THREE.PerspectiveCamera(84);
  await pano.loadInitial(nodes[0]);
  pano.prepareTransitionCapture(captureScene, nodes[0], new THREE.Vector3(0, 1.6, 0));
  await pano.prepare(nodes[1]);
  pano.navigate(nodes[1], 2000, { fadeStart: .6 });
  now = 1000;
  camera.position.set(1, 1.6, 0);
  pano.update(camera);
  assert.equal(opacity(scene, 'entry'), 1);
  assert.equal(opacity(scene, 'middle'), 0);
  assert.deepEqual(scene.getObjectByName('panorama-entry').position.toArray(), camera.position.toArray());
  assert.deepEqual(captureScene.children[0].position.toArray(), [0, 1.6, 0], 'projection origin stays at departure');
  assert.equal(cache.pins.get(nodes[0].faces[0]), 2, 'outgoing photo and projection retain their textures');
  now = 1600;
  pano.update(camera);
  assert.ok(Math.abs(opacity(scene, 'middle') - .5) < 1e-10);
  assert.equal(camera.fov, 84);
  now = 2000;
  pano.update(camera);
  assert.equal(opacity(scene, 'middle'), 1);
  assert.equal(scene.getObjectByName('panorama-entry'), undefined);
  pano.clearTransitionCapture();
  assert.equal(cache.pins.get(nodes[0].faces[0]), 0);
  assert.equal(cache.pins.get(nodes[1].faces[0]), 1);
  pano.dispose(); cache.dispose();
  assert.ok([...cache.pins.values()].every(count => count === 0));
});

test('nonprojected travel crossfades immediately and overview entry uses presentation opacity', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const scene = new THREE.Scene();
  const cache = makeCache();
  const pano = new PanoramaLayer(scene, cache);
  await pano.loadInitial(nodes[0]);
  await pano.prepare(nodes[1]);
  pano.navigate(nodes[1], 2000);
  now = 1000;
  pano.update(new THREE.PerspectiveCamera());
  assert.equal(opacity(scene, 'middle'), .5);
  await pano.prepare(nodes[2]);
  pano.navigate(nodes[2], 2000, { replaceImmediately: true });
  pano.setPresentationOpacity(0);
  assert.equal(scene.children.length, 1);
  assert.equal(opacity(scene, 'side'), 0);
  pano.setPresentationOpacity(.75);
  assert.equal(opacity(scene, 'side'), .75);
  pano.dispose(); cache.dispose();
  assert.ok([...cache.pins.values()].every(count => count === 0));
});

// Exercise the real navigation and camera tween without constructing a WebGLRenderer.
async function runtimeHarness(indexed, fov) {
  const runtime = Object.create(SphrRuntime.prototype);
  const cache = makeCache();
  runtime.scene = new THREE.Scene();
  runtime.renderer = {};
  runtime.camera = new THREE.PerspectiveCamera(fov);
  runtime.camera.position.set(0, 1.6, 0);
  runtime.controls = { target: new THREE.Vector3(.04, 1.62, -.1), enabled: true };
  runtime.camera.lookAt(runtime.controls.target);
  runtime.bootstrap = { space: { space_data: { nodes, navigation, navigationTransition: { enabled: false, navigationMs: 2000 } } } };
  runtime.tour = { spaces: [{ tourpoints: (indexed ? nodes : [nodes[0]]).map(node => ({ nodeUUID: node.uuid, viewMode: 'FPV', zoom: 0 })) }] };
  runtime.state = { viewMode: 'FPV', activeSpaceIndex: 0, activePointIndex: 0, guided: false };
  runtime.currentNode = nodes[0];
  runtime.textureCache = cache;
  runtime.panorama = new PanoramaLayer(runtime.scene, cache);
  runtime.nav = new NavigationLayer(runtime.scene, { navigation }, nodes);
  runtime.nav.init(); runtime.nav.setActive(nodes[0].uuid);
  runtime.audio = { play() {}, updateForPoint() {} };
  runtime.emitState = () => {}; // DOM diagnostics/callbacks are tested in the browser.
  await runtime.panorama.loadInitial(nodes[0]);
  return { runtime, dispose() { runtime.panorama.dispose(); runtime.nav.dispose(); cache.dispose(); } };
}

test('missing projection geometry keeps navigation locked until the fallback flight finishes', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { runtime, dispose } = await runtimeHarness(false, 84);
  runtime.bootstrap.space.space_data.navigationTransition.enabled = true;
  runtime.cubeScene = new THREE.Scene();
  runtime.cubeRenderTarget = { texture: new THREE.CubeTexture() };
  runtime.cubeCamera = { position: new THREE.Vector3(), update() {} };
  runtime.sceneGraph = { showNavigationTransition: () => null, setViewMode() {}, restoreNavigationTransition() {} };
  await runtime.navigateToNode(nodes[1]);
  assert.equal(runtime.cubeScene.children.length, 0, 'unused projection capture is released');
  now = 1500;
  runtime.cameraTween.update(now);
  runtime.navigationReleaseTween.update(now);
  assert.equal(runtime.state.navigating, true);
  assert.equal(runtime.controls.enabled, false);
  assert.equal(runtime.camera.fov, 84);
  now = 2000;
  runtime.cameraTween.update(now);
  runtime.navigationReleaseTween.update(now);
  assert.equal(runtime.controls.enabled, true);
  runtime.cubeRenderTarget.texture.dispose();
  dispose();
});

for (const indexed of [true, false]) {
  test(`${indexed ? 'indexed' : 'direct'} texture failure retains the current photo, pucks and zoom and restores controls`, async t => {
    const { runtime, dispose } = await runtimeHarness(indexed, 84);
    t.mock.method(runtime.panorama, 'prepare', async () => { throw new Error('Image unavailable'); });
    await runtime.navigateToNode(nodes[1]);
    assert.equal(runtime.currentNode.uuid, 'entry');
    assert.equal(runtime.panorama.getDebugSnapshot().activeNode, 'entry');
    assert.deepEqual(runtime.nav.getDebugSnapshot().renderedNodes, ['middle', 'side']);
    assert.equal(runtime.camera.fov, 84);
    assert.equal(runtime.state.navigating, false);
    assert.equal(runtime.controls.enabled, true);
    assert.match(runtime.state.navigationError, /Image unavailable/);
    dispose();
  });
}

for (const indexed of [true, false]) {
  for (const fov of [45, 82, 95]) {
    test(`${indexed ? 'indexed' : 'direct'} scan navigation preserves ${fov}° zoom and heading for the entire configured flight`, async t => {
      let now = 0;
      t.mock.method(performance, 'now', () => now);
      const { runtime, dispose } = await runtimeHarness(indexed, fov);
      const direction = runtime.camera.getWorldDirection(new THREE.Vector3());
      await runtime.navigateToNode(nodes[1]);
      for (now of [0, 500, 1000, 1500, 1999]) {
        runtime.cameraTween.update(now);
        runtime.navigationReleaseTween.update(now);
        runtime.panorama.update(runtime.camera);
        assert.equal(runtime.camera.fov, fov);
        assert.ok(runtime.camera.getWorldDirection(new THREE.Vector3()).distanceTo(direction) < 1e-10);
        assert.equal(runtime.state.navigating, true);
        assert.equal(runtime.controls.enabled, false);
        assert.equal(runtime.nav.getDebugSnapshot().transitioning, true);
      }
      now = 2000;
      runtime.cameraTween.update(now);
      runtime.navigationReleaseTween.update(now);
      runtime.panorama.update(runtime.camera);
      assert.deepEqual(runtime.camera.position.toArray(), [2, 1.6, 0]);
      assert.equal(runtime.camera.fov, fov);
      assert.equal(runtime.state.navigating, false);
      assert.equal(runtime.controls.enabled, true);
      assert.equal(runtime.panorama.getDebugSnapshot().fading, false);
      assert.equal(runtime.nav.getDebugSnapshot().transitioning, false);
      dispose();
    });
  }
}
