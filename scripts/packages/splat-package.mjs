// Packages a splat file (from a trainer, or converted from a point cloud) as an SPHR space.
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { bounds, freshFolder, orbitCamera, pointPreview, rotatePositions, startPoint, titlePreview, writePackage } from './common.mjs';
import { sampleSplats } from './splat-reader.mjs';

export async function packageSplat(input, id, { rotation = [0, 0, 0], interior = false, elevation, distance, kind = 'splat', tool = 'build-splat', inputs = [input], notes = {} } = {}) {
  const extension = path.extname(input).slice(1).toLowerCase();
  freshFolder(id.folder);
  mkdirSync(path.join(id.folder, 'splat'));
  const file = `splat/scene.${extension}`;
  copyFileSync(input, path.join(id.folder, file));
  const sample = sampleSplats(input);
  let camera, box = null;
  if (sample?.positions.length) {
    rotatePositions(sample.positions, rotation);
    box = bounds(sample.positions);
    camera = interior
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
    notes: { ...notes, splats: sample?.total ?? null, rotationDegrees: rotation.map(value => Math.round(value * 180 / Math.PI)), bounds: box } });
  return { folder: id.folder, preview: path.join(id.folder, 'preview.jpg'), files: manifest.files.length, splats: sample?.total ?? 'unknown', camera };
}
