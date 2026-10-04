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

test('capture links work both ways and hold beyond the distance used for unlinked scans', () => {
  const scene = new THREE.Scene();
  const far = [scan('a', 0, ['b']), scan('b', 12, []), scan('c', 3, ['a'])];
  const nav = new NavigationLayer(scene, { navigation: { ...navigation, maxDistance: 5 } }, far);
  nav.init();
  nav.setActive('a');
  assert.deepEqual(nav.getNavigableNodes().map(node => node.uuid), ['b', 'c'], 'a 12 m sightline and a one-way link both show');
  nav.setActive('b');
  assert.deepEqual(nav.getNavigableNodes().map(node => node.uuid), ['a'], 'a scan whose own list is empty is not a dead end');
  assert.equal(nav.canFlyTo('a'), true);
  assert.equal(nav.canFlyTo('c'), false, 'unlinked tour stops still cut instead of flying through walls');
  nav.dispose();
});

test('an unlinked scan offers its nearest scans, and a sealed doorway still leaves one way on', () => {
  const scene = new THREE.Scene();
  const island = [scan('a', 0, ['b']), scan('b', 2, ['a']), scan('lone', 30, [])];
  const nav = new NavigationLayer(scene, { navigation: { ...navigation, maxDistance: 5 } }, island);
  nav.init();
  nav.setActive('lone');
  assert.deepEqual(nav.getNavigableNodes().map(node => node.uuid), ['b']);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(.1, 4, 4), new THREE.MeshBasicMaterial());
  wall.position.set(1, 1.6, 0);
  scene.add(wall);
  nav.setOccluders([wall]);
  nav.setActive('a');
  assert.deepEqual(nav.getNavigableNodes().map(node => node.uuid), ['b']);
  nav.dispose(); wall.geometry.dispose(); wall.material.dispose();
});

test('distant pucks grow to stay visible while near and overview pucks keep their size', () => {
  const scene = new THREE.Scene();
  const spread = [scan('a', 0, ['near', 'far']), scan('near', 1.5, ['a']), scan('far', 9, ['a'])];
  const nav = new NavigationLayer(scene, { navigation }, spread);
  nav.init();
  nav.setActive('a');
  scene.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(75);
  camera.position.set(0, 1.6, 0);
  nav.update(camera, 800);
  const scale = uuid => nav.group.getObjectByName(`nav-${uuid}`).scale.x;
  assert.equal(scale('near'), 1);
  const focal = 800 / (2 * Math.tan(THREE.MathUtils.degToRad(37.5)));
  const distance = Math.hypot(9, 1.575);
  assert.ok(Math.abs(scale('far') * .15 * focal / distance - 20) < 1e-9, 'a 9 m puck is 20 px in radius');
  nav.setOrbit(true);
  nav.update(camera, 800);
  assert.equal(scale('far'), 1);
  nav.setHovered('near');
  const ring = nav.group.getObjectByName('nav-near').children[0].material;
  assert.equal(ring.opacity, 1);
  nav.setHovered(null);
  assert.ok(ring.opacity < 1);
  nav.dispose();
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

test('arrow keys walk forward and back along the heading and turn the view', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { runtime, dispose } = await runtimeHarness(false, 75);
  runtime.controls.target.set(.1, 1.6, 0);
  runtime.camera.lookAt(runtime.controls.target);
  const settle = () => { for (now of [now, now + 2000]) { runtime.cameraTween.update(now); runtime.navigationReleaseTween.update(now); } };
  await runtime.stepInDirection(-1);
  assert.equal(runtime.currentNode.uuid, 'side', 'down steps back while still facing ahead');
  settle();
  assert.ok(runtime.camera.getWorldDirection(new THREE.Vector3()).x > .99);
  await runtime.stepInDirection(1);
  assert.equal(runtime.currentNode.uuid, 'entry');
  settle();
  await runtime.stepInDirection(1);
  assert.equal(runtime.currentNode.uuid, 'middle');
  settle();
  runtime.turnView(Math.PI / 2);
  const look = runtime.controls.target.clone().sub(runtime.camera.position);
  assert.ok(Math.abs(look.x) < 1e-9 && look.z < 0, 'a left turn faces -z');
  runtime.camera.lookAt(runtime.controls.target); // OrbitControls does this every frame
  await runtime.stepInDirection(1);
  assert.equal(runtime.currentNode.uuid, 'middle', 'nothing lies that way, so the camera stays');
  dispose();
});

// A loaded reconstruction stand-in that records what the runtime shows.
function fakeReconstruction() {
  return { ready: true, failed: false, busy: false, opacity: 0, sky: 0, info: {},
    get visible() { return this.opacity > 0; },
    setOpacity(value) { this.opacity = value; }, setSky(value) { this.sky = value; }, getRaycastObjects: () => [], update() {} };
}

test('with the reconstruction in view, steps between scans fly without the projected photo and keep loading panoramas', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { runtime, dispose } = await runtimeHarness(false, 75);
  runtime.bootstrap.space.space_data.navigationTransition.enabled = true;
  runtime.cubeScene = new THREE.Scene();
  runtime.cubeRenderTarget = { texture: new THREE.CubeTexture() };
  runtime.cubeCamera = { position: new THREE.Vector3(), update() {} };
  let projected = 0;
  runtime.sceneGraph = { showNavigationTransition: () => { projected += 1; return null; }, setViewMode() {}, restoreNavigationTransition() {},
    getRaycastObjects: () => [], capture: 1, setCaptureOpacity(value) { this.capture = value; }, get captureReplaced() { return this.capture === 0; } };
  runtime.reconstruction = fakeReconstruction();
  const pucks = () => { const states = []; runtime.nav.group.traverse((child) => { if (child.material?.userData?.puck) states.push(child.material.depthTest); }); return states; };

  runtime.toggleReconstruction();
  now = 350;
  runtime.reconTween.update(now);
  const halfway = runtime.panorama.getDebugSnapshot().veil;
  assert.equal(runtime.reconstruction.opacity, 1, 'in first person the model is solid while the photograph fades over it');
  assert.ok(halfway > 0.2 && halfway < 0.8);
  now = 700;
  runtime.reconTween.update(now);
  assert.equal(runtime.panorama.getDebugSnapshot().veil, 1);
  assert.equal(runtime.reconstruction.sky, 1);
  assert.equal(runtime.sceneGraph.capture, 0, 'the capture stops hiding placed objects');
  assert.ok(pucks().every((depthTest) => depthTest === false), 'location markers draw over the model');

  await runtime.navigateToNode(nodes[1]);
  assert.equal(projected, 0, 'no projected photo while the model is in view');
  assert.equal(runtime.panorama.getDebugSnapshot().activeNode, 'middle', 'the photographs keep loading behind it');
  for (now of [1000, 2000, 2700]) {
    runtime.cameraTween?.update(now);
    runtime.navigationReleaseTween?.update(now);
    assert.equal(runtime.panorama.getDebugSnapshot().veil, 1);
  }
  assert.deepEqual(runtime.camera.position.toArray(), [2, 1.6, 0]);
  assert.equal(runtime.state.navigating, false);

  runtime.toggleReconstruction();
  now = 3500;
  runtime.reconTween.update(now);
  assert.equal(runtime.panorama.getDebugSnapshot().veil, 0, 'turned off, the new scan\'s photograph shows');
  assert.equal(runtime.reconstruction.opacity, 0);
  assert.equal(runtime.sceneGraph.capture, 1);
  assert.ok(pucks().every((depthTest) => depthTest === true));
  runtime.cubeRenderTarget.texture.dispose();
  dispose();
});

test('a guided tour shows the reconstruction only at stops that ask for it, free exploration leaves it to the visitor', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { runtime, dispose } = await runtimeHarness(true, 75);
  runtime.tour.spaces[0].tourpoints[1].reconstruction = true;
  runtime.tour.spaces[0].tourpoints[2].reconstruction = false;
  runtime.reconstruction = fakeReconstruction();
  runtime.sceneGraph = { setViewMode() {}, showOnly() {}, restoreNavigationTransition() {}, getRaycastObjects: () => [], setCaptureOpacity() {}, captureReplaced: false };
  runtime.annotations = { show() {} };
  runtime.applyExperienceForPoint = () => {};
  const finish = () => { for (now of [now + 2500, now + 5000]) { runtime.cameraTween?.update(now); runtime.navigationReleaseTween?.update(now); runtime.reconTween?.update(now); } };
  await runtime.goTo(0, 1);
  finish();
  assert.equal(runtime.reconFpv ?? false, false, 'free exploration ignores the stop');
  runtime.state.guided = true;
  await runtime.goTo(0, 0);
  finish();
  await runtime.goTo(0, 1);
  finish();
  assert.equal(runtime.reconFpv, true);
  assert.equal(runtime.panorama.getDebugSnapshot().veil, 1, 'the stop shows the model in place of the photograph');
  await runtime.goTo(0, 0);
  finish();
  assert.equal(runtime.reconFpv, false, 'a stop that says nothing shows the capture');
  assert.equal(runtime.panorama.getDebugSnapshot().veil, 0);
  await runtime.goTo(0, 2);
  finish();
  assert.equal(runtime.reconFpv, false);
  assert.equal(runtime.panorama.getDebugSnapshot().veil, 0);
  dispose();
});
