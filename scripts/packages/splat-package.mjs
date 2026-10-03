// Packages a splat file (from a trainer, or converted from a point cloud) as an SPHR space.
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { bounds, denseCore, freshFolder, levelRotation, orbitCamera, pointPreview, rotatePositions, startPoint, titlePreview, writePackage } from './common.mjs';
import { cameraLevelRotation, cameraStartView } from './colmap-cameras.mjs';
import { sampleSplats } from './splat-reader.mjs';

/** Whether camera centres sit inside the splat's dense body (grown by its radius), i.e. share its axes. */
function camerasMatch(cameras, box) {
  const margin = box.radius;
  const inside = cameras.filter(({ center: [x, y, z] }) => x > box.min.x - margin && x < box.max.x + margin
    && y > box.min.y - margin && y < box.max.y + margin && z > box.min.z - margin && z < box.max.z + margin);
  return inside.length >= 0.8 * cameras.length;
}

export async function packageSplat(input, id, { rotation, level = false, interior = false, elevation, distance, cameras, kind = 'splat', tool = 'build-splat', inputs = [input], notes = {} } = {}) {
  const extension = path.extname(input).slice(1).toLowerCase();
  freshFolder(id.folder);
  mkdirSync(path.join(id.folder, 'splat'));
  const file = `splat/scene.${extension}`;
  copyFileSync(input, path.join(id.folder, file));
  const sample = sampleSplats(input);
  let camera, box = null, leveled = null, start = null;
  // The cameras of the reconstruction the splat was trained from (COLMAP) know where up is and where the
  // capture was taken from, but only if the trainer kept COLMAP's axes.
  if (cameras?.length && sample?.positions.length && !camerasMatch(cameras, bounds(denseCore(sample.positions)))) {
    start = { kind: 'ignored', reason: 'the camera positions do not lie inside the splat' };
    cameras = null;
  }
  // An explicit rotation wins; then the cameras' up direction; then the splat's ground plane when one exists.
  if (!rotation && level && cameras?.length) rotation = cameraLevelRotation(cameras);
  if (!rotation && level && sample?.positions.length) leveled = levelRotation(sample.positions);
  rotation ??= leveled?.rotation ?? [0, 0, 0];
  if (sample?.positions.length) {
    rotatePositions(sample.positions, rotation);
    // Frame the dense body of the capture, not stray floaters or far background.
    box = bounds(denseCore(sample.positions));
    if (cameras?.length && !interior && elevation === undefined && distance === undefined) {
      const view = cameraStartView(cameras, rotation);
      camera = view.camera;
      start = { kind: view.kind, from: view.camera.from };
    }
    camera ??= interior
      ? { position: { ...box.median }, rotation: { azimuth: 0, polar: 0 }, target: box.median }
      : orbitCamera(box, { ...(elevation !== undefined ? { elevation } : {}), ...(distance !== undefined ? { distance } : {}) });
    await pointPreview(sample.positions, sample.colors, box, path.join(id.folder, 'preview.jpg'), camera);
  } else {
    camera = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, rotation: { azimuth: 0, polar: -20 }, distance: 6 };
    await titlePreview(id.title, path.join(id.folder, 'preview.jpg'));
  }
  const bootstrap = {
    space: { id: id.sceneId, title: id.title, type: 'splat', space_data: {
      noPanos: true, initialPosition: camera.position, initialRotation: camera.rotation,
      splats: [{ id: 'main', url: `${id.datasetUrl}/${file}`, fileType: extension, rotation, lod: true, reveal: true }]
    } },
    tour: { title: id.title, tour_data: { mode: 'explore', spaces: [{ id: id.sceneId, title: id.title, tourpoints: [startPoint(camera)] }] } }
  };
  const manifest = await writePackage({ id, kind, bootstrap, inputs, tool,
    notes: { ...notes, splats: sample?.total ?? null, rotationDegrees: rotation.map(value => Math.round(value * 180 / Math.PI)),
      leveled: leveled ? { ground: Number(leveled.ground.toFixed(3)) } : null, bounds: box, ...(start ? { start } : {}) } });
  return { folder: id.folder, preview: path.join(id.folder, 'preview.jpg'), files: manifest.files.length, splats: sample?.total ?? 'unknown',
    rotationDegrees: rotation.map(value => Math.round(value * 180 / Math.PI)), leveled: Boolean(leveled && leveled.rotation.some(Boolean)),
    ...(start ? { start } : {}), camera };
}
