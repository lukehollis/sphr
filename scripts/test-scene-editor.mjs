import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import sharp from 'sharp';
import * as THREE from 'three';
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
const { applySceneEdits, editedListing, validateStartView, editorBootstrap } = await import('../lib/scene-edits.ts');
const { normalizeTour } = await import('../lib/bootstrap.ts');
const { SphrRuntime } = await import('../lib/three/SphrRuntime.ts');
const { cameraDirection } = await import('../lib/three/math.ts');
const { decodeThumbnail } = await import('../lib/server/scene-editor.ts');
const store = await import('../lib/server/admin-store.ts');
const directory = mkdtempSync(path.join(tmpdir(), 'sphr-editor-'));
process.env.SPHR_STATE_DIR = directory;
process.env.SPHR_ACCESS_CONTROL = '1';
after(() => rmSync(directory, { recursive: true, force: true }));
const view = { nodeId: 'second', position: { x: 2, y: 1.6, z: 0 }, rotation: { azimuth: 133, polar: -12 }, fov: 97 };
const input = { space: { id: 'native', title: 'Imported title', space_data: { initialNode: 'first',
  nodes: ['first', 'second'].map((uuid, i) => ({ uuid, position: { x: i * 2, y: 1.6, z: 0 } })) } },
  tour: { title: 'Imported tour', tour_data: { mode: 'explore', spaces: [{ id: 'native', tourpoints: [
    { nodeUUID: 'first', text: 'Opening', sounds: ['voice'], fov: 75 }, { nodeUUID: 'second', text: 'Next', fov: 75 }
  ] }] } } };

test('explore entry chooses the saved scan, direction and zoom without modifying the source', () => {
  const output = applySceneEdits(input, { title: 'Edited title', startView: view });
  assert.equal(output.space.space_data.initialNode, 'second');
  assert.equal(output.space.title, 'Edited title');
  assert.equal(input.space.space_data.initialNode, 'first');
  assert.equal(input.tour.tour_data.spaces[0].tourpoints[1].fov, 75);
  const runtime = Object.create(SphrRuntime.prototype);
  runtime.bootstrap = output; runtime.tour = normalizeTour(output); runtime.nav = null;
  const node = runtime.resolveInitialNode();
  assert.equal(node.uuid, view.nodeId);
  const location = runtime.findTourPointForNode(node.uuid);
  const point = runtime.tour.spaces[0].tourpoints[location.pointIndex];
  const pose = runtime.poseForPoint(point, 'FPV');
  assert.equal(pose.fov, 97);
  assert.deepEqual(pose.position.toArray(), [2, 1.6, 0]);
  assert.ok(pose.target.clone().sub(pose.position).normalize().distanceTo(cameraDirection(view.rotation)) < 1e-12);
});

test('guided edit retains first-stop narrative, media and subsequent stops; editor never starts narration', () => {
  const guided = structuredClone(input); guided.tour.tour_data.mode = 'guided';
  const output = applySceneEdits(guided, { title: null, startView: view });
  const [first, next] = output.tour.tour_data.spaces[0].tourpoints;
  assert.equal(normalizeTour(output).hasGuidedTour, true);
  assert.equal(first.nodeUUID, 'second'); assert.equal(first.text, 'Opening'); assert.deepEqual(first.sounds, ['voice']);
  assert.deepEqual(next, guided.tour.tour_data.spaces[0].tourpoints[1]);
  const editor = editorBootstrap(output);
  assert.equal(normalizeTour(editor).hasGuidedTour, false);
  assert.equal(editor.space.space_data.initialNode, 'second');
  assert.deepEqual(normalizeTour(editor).audio, {});
});

test('camera validation rejects invalid poses, removed scans and external viewers', () => {
  for (const invalid of [{ ...view, fov: NaN }, { ...view, fov: 2 }, { ...view, nodeId: 'missing' },
    { ...view, nodeId: undefined }, { ...view, rotation: { azimuth: 0, polar: 100 } }, {}]) {
    assert.throws(() => validateStartView(invalid, input));
  }
  const external = { space: { ...input.space, type: 'matterport' } };
  assert.throws(() => validateStartView(view, external));
  assert.deepEqual(applySceneEdits(input, { title: null, startView: { ...view, nodeId: 'removed' } }), input);
});

test('single free-camera scenes gain an explore start without inventing a guided tour', () => {
  const source = { space: { id: 'free', title: 'Splat', space_data: { noPanos: true } } };
  const freeView = { ...view, nodeId: undefined };
  const output = applySceneEdits(source, { title: null, startView: freeView });
  const tour = normalizeTour(output);
  assert.equal(tour.hasGuidedTour, false);
  assert.equal(tour.spaces[0].tourpoints[0].fov, 97);
  assert.deepEqual(tour.spaces[0].tourpoints[0].position, view.position);
});

test("an owner's tags stand in for the capture's own, in the opening space of a tour too", () => {
  const imported = [{ id: 'mp-1', title: 'From Matterport', position: { x: 0, y: 1, z: 0 }, source: 'matterport' }];
  const owner = [{ id: 'tag-own', title: 'Mine', position: { x: 1, y: 1, z: 0 } }];
  const source = structuredClone(input); source.space.space_data.tags = imported;
  assert.deepEqual(applySceneEdits(source, { title: null, startView: null, tags: null }).space.space_data.tags, imported, "no saved tags keeps the capture's");
  assert.deepEqual(applySceneEdits(source, { title: null, startView: null, tags: owner }).space.space_data.tags, owner);
  assert.deepEqual(applySceneEdits(source, { title: null, startView: null, tags: [] }).space.space_data.tags, [], 'deleting every tag is kept too');
  assert.deepEqual(source.space.space_data.tags, imported, 'the source is left alone');
  const chain = { ...structuredClone(source), orderedSpaces: [structuredClone(source.space), { id: 'later', title: 'Later', space_data: { tags: imported } }] };
  const chained = applySceneEdits(chain, { title: null, startView: null, tags: owner });
  assert.deepEqual(chained.orderedSpaces[0].space_data.tags, owner, 'the opening space gets them');
  assert.deepEqual(chained.orderedSpaces[1].space_data.tags, imported, 'later spaces keep their own');
});

test('a tag is shown from the nearest panorama with nothing in the way', () => {
  const runtime = Object.create(SphrRuntime.prototype);
  runtime.bootstrap = input;
  runtime.nav = { getWorldPosition: node => new THREE.Vector3(node.position.x, node.position.y, node.position.z) };
  const tag = new THREE.Vector3(0, 1.5, 1.5);
  runtime.sceneGraph = { getRaycastObjects: () => [] };
  assert.equal(runtime.nodeSeeing(tag).uuid, 'first', 'the nearest, when nothing stands between');
  // A wall piece between the first panorama and the tag, clear of the line from the second.
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 3), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  wall.position.set(0, 1.5, 0.75);
  wall.updateMatrixWorld(true);
  runtime.sceneGraph = { getRaycastObjects: () => [wall] };
  assert.equal(runtime.nodeSeeing(tag).uuid, 'second');
});

test('thumbnail decoder rejects spoofed/truncated/oversize images and produces a real JPEG', async () => {
  const source = await sharp({ create: { width: 960, height: 640, channels: 3, background: '#346578' } }).jpeg().toBuffer();
  const data = `data:image/jpeg;base64,${source.toString('base64')}`;
  const output = await decodeThumbnail(data);
  assert.equal((await sharp(output).metadata()).format, 'jpeg');
  assert.equal((await sharp(output).metadata()).width, 960);
  await assert.rejects(() => decodeThumbnail('data:image/jpeg;base64,AAAA'));
  await assert.rejects(() => decodeThumbnail(`data:image/jpeg;base64,${source.subarray(0, 200).toString('base64')}`));
  await assert.rejects(() => decodeThumbnail(data + 'a'.repeat(1000000)));
  const png = await sharp(source).png().toBuffer();
  await assert.rejects(() => decodeThumbnail(`data:image/jpeg;base64,${png.toString('base64')}`));
});

test('atomic edits survive restart and reimports; stale writers cannot replace a thumbnail or visibility', () => {
  const id = '0123456789ab';
  store.setScenePublic(id, false);
  const edits = store.saveSceneEdits(id, 0, 'Revised title', { view, thumbnail: Buffer.from('thumbnail-test') });
  assert.equal(edits.revision, 1);
  assert.deepEqual(store.readSceneEdits().get(id).startView, view);
  assert.equal(Buffer.from(store.readSceneThumbnail(id)).toString(), 'thumbnail-test');
  assert.throws(() => store.saveSceneEdits(id, 0, 'Stale', null), store.EditConflict);
  assert.equal(store.readSceneEdits().get(id).revision, 1);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { readSceneEdits } from './lib/server/admin-store.ts'; console.log(JSON.stringify(readSceneEdits().get('${id}')));`], { env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), edits);
  const source = { sceneId: id, title: 'Reimported title', titleSlug: 'reimported', thumbnail: '/original.jpg' };
  const listing = editedListing(source, edits);
  assert.equal(listing.scenePath, `/s/${id}/revised-title`);
  assert.match(listing.thumbnail, /\/api\/scenes\/.+\/thumbnail\?v=/);
  store.saveSceneEdits(id, 1, 'Title only');
  assert.deepEqual(store.readSceneEdits().get(id).startView, view);
  assert.equal(store.isScenePublic(id), false);
  const reset = store.saveSceneEdits(id, 2, null, null);
  assert.equal(reset.startView, null); assert.equal(store.readSceneThumbnail(id), undefined);
  assert.equal(editedListing(source, reset).thumbnail, '/original.jpg');
});
