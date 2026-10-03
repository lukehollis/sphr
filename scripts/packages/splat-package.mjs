// Packages a splat file (from a trainer, or converted from a point cloud) as an SPHR space.
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { bounds, denseCore, eulerTurningToUp, freshFolder, levelRotation, orbitCamera, pointPreview, rotatePositions, startPoint, subjectCore, titlePreview, viewRotation, writePackage } from './common.mjs';
import { cameraStartView, cameraUp } from './colmap-cameras.mjs';
import { sampleSplats } from './splat-reader.mjs';

/** 5th and 95th percentile of each axis. */
function spread(positions) {
  return [0, 1, 2].map(axis => {
    const values = [];
    for (let index = axis; index < positions.length; index += 3) values.push(positions[index]);
    values.sort((a, b) => a - b);
    return [values[Math.floor(values.length * 0.05)], values[Math.floor(values.length * 0.95)]];
  });
}

/**
 * Whether the splat kept the axes of the reconstruction it was trained from: trainers start from COLMAP's
 * sparse points, so both clouds cover the same region at the same scale unless the trainer moved them.
 * Without sparse points, the cameras must at least stand within the splat.
 */
function camerasMatch(cameras, points, positions) {
  const splat = spread(positions);
  if (points?.length >= 300) {
    return spread(points).every(([low, high], axis) => {
      const [splatLow, splatHigh] = splat[axis];
      const size = Math.max(high - low, 1e-6), splatSize = Math.max(splatHigh - splatLow, 1e-6);
      return Math.abs((low + high) / 2 - (splatLow + splatHigh) / 2) < 0.25 * Math.max(size, splatSize)
        && splatSize / size > 0.5 && splatSize / size < 2;
    });
  }
  const inside = cameras.filter(({ center }) => center.every((value, axis) => {
    const [low, high] = splat[axis], margin = (high - low) * 0.25;
    return value > low - margin && value < high + margin;
  }));
  return inside.length >= 0.8 * cameras.length;
}

/** First-person view from a scanner station, looking level toward the middle of the capture. */
function stationView([x, y, z], box) {
  const toward = [box.median.x - x, 0, box.median.z - z];
  const rotation = Math.hypot(...toward) > 0.5 ? viewRotation(toward) : { azimuth: 0, polar: 0 };
  return { position: { x, y, z }, rotation, target: { x, y, z } };
}

export async function packageSplat(input, id, { rotation, level = false, interior = false, elevation, distance, cameras, sparsePoints, stations, floor, kind = 'splat', tool = 'build-splat', inputs = [input], notes = {} } = {}) {
  const extension = path.extname(input).slice(1).toLowerCase();
  freshFolder(id.folder);
  mkdirSync(path.join(id.folder, 'splat'));
  const file = `splat/scene.${extension}`;
  copyFileSync(input, path.join(id.folder, file));
  const sample = sampleSplats(input, 1_000_000);
  let camera, box = null, leveled = null, start = null;
  // The cameras of the reconstruction the splat was trained from (COLMAP) know where up is and where the
  // capture was taken from, but only if the trainer kept COLMAP's axes.
  if (cameras?.length && sample?.positions.length && !camerasMatch(cameras, sparsePoints, sample.positions)) {
    start = { kind: 'ignored', reason: 'the camera positions do not lie inside the splat' };
    cameras = null;
  }
  // An explicit rotation wins. With cameras: the ground plane when it agrees with them, otherwise their up.
  // Without: the ground plane when one exists.
  if (!rotation && level && sample?.positions.length) leveled = levelRotation(sample.positions);
  if (!rotation && level && cameras?.length) {
    // The cameras' up assumes they were held without roll; a 360 camera on a tilted stick breaks that, so a
    // clear ground plane within 30 degrees of it is the better measurement. A wall that outnumbers the floor
    // lies far from the cameras' up and is ignored.
    const up = cameraUp(cameras);
    const agreement = leveled ? leveled.up.reduce((sum, value, axis) => sum + value * up[axis], 0) : 0;
    if (Math.abs(agreement) > Math.cos(30 * Math.PI / 180)) {
      rotation = eulerTurningToUp(leveled.up.map(value => value * Math.sign(agreement)));
      start = { leveledBy: 'ground' };
    } else {
      rotation = eulerTurningToUp(up);
      leveled = null;
      start = { leveledBy: 'cameras' };
    }
  }
  rotation ??= leveled?.rotation ?? [0, 0, 0];
  if (sample?.positions.length) {
    rotatePositions(sample.positions, rotation);
    // Frame the subject (small, well-resolved splats in the dense body), not floaters or far background.
    box = bounds(subjectCore(sample.positions, sample.extents));
    if (cameras?.length && !interior && elevation === undefined && distance === undefined) {
      const view = cameraStartView(cameras, rotation);
      camera = view.camera;
      start = { ...start, kind: view.kind, from: view.camera.from };
    }
    // Scanner stations are only known unrotated, so they are used when the capture keeps its axes.
    if (interior && stations?.length && !rotation.some(Boolean)) camera = stationView(stations[0], box);
    // Without a station, stand in the middle; at eye height when the floor level is known.
    const middle = floor === undefined ? { ...box.median } : { ...box.median, y: floor + Math.min(1.6, (box.max.y - floor) * 0.6) };
    camera ??= interior
      ? { position: middle, rotation: { azimuth: 0, polar: 0 }, target: middle }
      : orbitCamera(box, { ...(elevation !== undefined ? { elevation } : {}), ...(distance !== undefined ? { distance } : {}) });
    await pointPreview(sample.positions, sample.colors, box, path.join(id.folder, 'preview.jpg'), camera, sample.extents);
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
