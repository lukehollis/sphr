#!/usr/bin/env node
// Packages equirectangular 360 photos as an SPHR space: one panorama per photo and, for more
// than one, a guided tour through them in order.
//   node scripts/packages/build-panoramas.mjs --input photos/ [--input more.jpg] --title "Title" [--max-width 8192] [--captions]
// Photos must be 2:1 equirectangular (Insta360, Ricoh Theta, GoPro Max, phone panorama exports).
// Other images are skipped and listed in the output so they can be reported to the customer.
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fail, freshFolder, identity, isMain, list, parseArgs, previewSize, writePackage } from './common.mjs';

const imageTypes = /\.(jpe?g|png|webp|tiff?|avif|heic|heif)$/i;

export function collectImages(inputs) {
  return inputs.flatMap(input => statSync(input).isDirectory()
    ? readdirSync(input).filter(name => !name.startsWith('.')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(name => path.join(input, name))
    : [input]).filter(file => imageTypes.test(file));
}

/** Writes the package; returns which inputs became panoramas and which were skipped. */
export async function buildPanoramas(images, id, { maxWidth = 8192, captions = false, kind = 'panoramas', tool = 'build-panoramas', inputs = images, spacing = 3 } = {}) {
  freshFolder(id.folder);
  mkdirSync(path.join(id.folder, 'pano'));
  const used = [], skipped = [];
  for (const image of images) {
    let meta;
    try { meta = await sharp(image, { failOn: 'error' }).metadata(); }
    catch (error) { skipped.push({ file: path.basename(image), reason: `unreadable image (${error.message})` }); continue; }
    const [width, height] = meta.orientation && meta.orientation >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
    const ratio = width / height;
    if (ratio < 1.9 || ratio > 2.1) { skipped.push({ file: path.basename(image), reason: `not a 2:1 equirectangular 360 photo (${width}×${height})` }); continue; }
    const index = used.length + 1;
    const name = `pano/${String(index).padStart(3, '0')}.jpg`;
    // The viewer maps photos onto the inside of a sphere, which mirrors them; store them flipped.
    await sharp(image, { limitInputPixels: 30000 * 15000 }).rotate().flop().resize({ width: Math.min(width, maxWidth), withoutEnlargement: true })
      .jpeg({ quality: 82, progressive: true, mozjpeg: true }).toFile(path.join(id.folder, name));
    used.push({ file: image, name, width, height, label: path.basename(image).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') });
  }
  if (!used.length) return { used, skipped };

  // The middle band of the first photo, looking forward, becomes the thumbnail.
  const first = sharp(path.join(id.folder, used[0].name)).flop();
  const { width, height } = await first.metadata();
  const band = { width: Math.round(width / 3), height: Math.round(width / 3 * previewSize.height / previewSize.width) };
  await first.extract({ left: Math.round((width - band.width) / 2), top: Math.round((height - band.height) / 2), width: band.width, height: band.height })
    .resize(previewSize).jpeg({ quality: 88 }).toFile(path.join(id.folder, 'preview.jpg'));

  const nodes = used.map((item, index) => ({
    uuid: `pano-${String(index + 1).padStart(3, '0')}`, index, label: item.label,
    image: `${id.datasetUrl}/${item.name}`, position: { x: index * spacing, y: 1.6, z: 0 }, rotation: { x: 0, y: Math.PI / 2, z: 0 },
    neighbors: [index - 1, index + 1].filter(other => other >= 0 && other < used.length).map(other => `pano-${String(other + 1).padStart(3, '0')}`)
  }));
  const guided = nodes.length > 1;
  const tourpoints = guided ? nodes.map(node => ({ id: node.uuid, viewMode: 'FPV', targetType: 'NODE', nodeUUID: node.uuid,
    position: node.position, rotation: { azimuth: 0, polar: 0 }, zoom: 0, ...(captions ? { text: `<p>${node.label}</p>` } : {}),
    files: [], models: [], annotations: [], sounds: [] })) : [];
  const bootstrap = {
    space: { id: id.sceneId, title: id.title, type: 'spaces', space_data: {
      initialNode: nodes[0].uuid, initialRotation: { azimuth: 0, polar: 0 }, nodes,
      navigation: { mode: 'neighbors', maxDistance: spacing * 1.5 }
    } },
    tour: { title: id.title, tour_data: { mode: guided ? 'guided' : 'explore', defaultShowText: captions,
      spaces: [{ id: id.sceneId, title: id.title, tourpoints }] } }
  };
  await writePackage({ id, kind, sourceType: kind, bootstrap, nodeCount: nodes.length, inputs, tool, notes: { skipped } });
  return { used, skipped };
}

if (isMain(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const inputs = list(options.input);
  if (!inputs.length || !inputs.every(existsSync)) fail('Pass --input with photos or a folder of photos.');
  const id = identity(options);
  const { used, skipped } = await buildPanoramas(collectImages(inputs), id, { maxWidth: Number(options['max-width'] ?? 8192), captions: Boolean(options.captions), inputs });
  if (!used.length) fail(JSON.stringify({ error: 'No 2:1 equirectangular photos found.', skipped }, null, 2));
  console.log(JSON.stringify({ folder: id.folder, preview: path.join(id.folder, 'preview.jpg'), panoramas: used.length, skipped }, null, 2));
}
