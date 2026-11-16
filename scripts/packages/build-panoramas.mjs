#!/usr/bin/env node
// Packages equirectangular 360 photos as an SPHR space: one panorama per photo and, for more
// than one, a guided tour through them in order.
//   node scripts/packages/build-panoramas.mjs --input photos/ [--input more.jpg] --title "Title" [--max-width 8192] [--captions] [--labels "Entrance,Living room"]
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

export function cleanPanoramaLabel(filename) {
  const stem = path.basename(filename).replace(/\.[^.]+$/, '');
  const stripped = stem.replace(/^\d+[\s._-]+(?=[A-Za-zÀ-ÿ]{2})/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const text = stripped || stem.replace(/[_-]+/g, ' ').trim();
  return text && text === text.toLowerCase() ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Picks an opening azimuth (degrees) for an already-flopped panorama file: keeps 0° (the camera's
 * forward lens) unless the forward 120° horizon window is a featureless blank wall (<45% of the
 * richest sector's gradient detail), in which case it turns toward the most detailed horizon view.
 */
export async function chooseOpeningAzimuth(floppedPath) {
  const w = 360, h = 180;
  const { data } = await sharp(floppedPath).flop().resize(w, h, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const colScore = new Float64Array(w);
  for (let y = 54; y < 126; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const here = data[row + x];
      const right = data[row + ((x + 1) % w)];
      const down = data[row + w + x];
      colScore[x] += Math.abs(here - right) + Math.abs(here - down);
    }
  }
  const windowScore = centerCol => {
    let sum = 0;
    for (let dx = -60; dx < 60; dx++) sum += colScore[(centerCol + dx + w) % w];
    return sum;
  };
  const forward = windowScore(180);
  let bestAzimuth = 0, bestScore = forward;
  for (const azimuth of [30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
    const centerCol = ((Math.round((0.5 - azimuth / 360) * w) % w) + w) % w;
    const score = windowScore(centerCol);
    if (score > bestScore) { bestScore = score; bestAzimuth = azimuth; }
  }
  return bestScore > 0 && forward < bestScore * 0.45 ? bestAzimuth : 0;
}

async function writePreviewAtAzimuth(floppedPath, azimuth, outPath) {
  const unflopped = await sharp(floppedPath).flop().toBuffer();
  const { width, height } = await sharp(unflopped).metadata();
  const band = { width: Math.round(width / 3), height: Math.round(width / 3 * previewSize.height / previewSize.width) };
  const top = Math.max(0, Math.round((height - band.height) / 2));
  const centerX = ((0.5 - azimuth / 360) % 1 + 1) % 1;
  const rawLeft = Math.round(centerX * width - band.width / 2);
  if (rawLeft >= 0 && rawLeft + band.width <= width) {
    await sharp(unflopped).extract({ left: rawLeft, top, width: band.width, height: band.height })
      .resize(previewSize).jpeg({ quality: 88 }).toFile(outPath);
    return;
  }
  const left = ((rawLeft % width) + width) % width;
  const firstWidth = width - left;
  const secondWidth = band.width - firstWidth;
  const [leftPart, rightPart] = await Promise.all([
    sharp(unflopped).extract({ left, top, width: firstWidth, height: band.height }).toBuffer(),
    sharp(unflopped).extract({ left: 0, top, width: secondWidth, height: band.height }).toBuffer()
  ]);
  await sharp({ create: { width: band.width, height: band.height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: leftPart, left: 0, top: 0 }, { input: rightPart, left: firstWidth, top: 0 }])
    .resize(previewSize).jpeg({ quality: 88 }).toFile(outPath);
}

/** Writes the package; returns which inputs became panoramas and which were skipped. */
export async function buildPanoramas(images, id, { maxWidth = 8192, captions = false, kind = 'panoramas', tool = 'build-panoramas', inputs = images, spacing = 3, labels } = {}) {
  freshFolder(id.folder);
  mkdirSync(path.join(id.folder, 'pano'));
  const customLabels = Array.isArray(labels) ? labels : undefined;
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
    const outFile = path.join(id.folder, name);
    // The viewer maps photos onto the inside of a sphere, which mirrors them; store them flipped.
    await sharp(image, { limitInputPixels: 30000 * 15000 }).rotate().flop().resize({ width: Math.min(width, maxWidth), withoutEnlargement: true })
      .jpeg({ quality: 82, progressive: true, mozjpeg: true }).toFile(outFile);
    const azimuth = await chooseOpeningAzimuth(outFile);
    const label = customLabels?.[used.length]?.trim()
      || (labels === 'stops' ? `Stop ${used.length + 1}` : cleanPanoramaLabel(image));
    used.push({ file: image, name, width, height, azimuth, label });
  }
  if (!used.length) return { used, skipped };

  await writePreviewAtAzimuth(path.join(id.folder, used[0].name), used[0].azimuth, path.join(id.folder, 'preview.jpg'));

  const nodes = used.map((item, index) => ({
    uuid: `pano-${String(index + 1).padStart(3, '0')}`, index, label: item.label,
    image: `${id.datasetUrl}/${item.name}`,
    position: { x: index * spacing, y: 1.6, z: 0 },
    floorPosition: { x: index * spacing, y: 0.025, z: 0 },
    rotation: { x: 0, y: Math.PI / 2, z: 0 },
    neighbors: [index - 1, index + 1].filter(other => other >= 0 && other < used.length).map(other => `pano-${String(other + 1).padStart(3, '0')}`)
  }));
  const guided = nodes.length > 1;
  const tourpoints = guided ? nodes.map((node, index) => ({ id: node.uuid, viewMode: 'FPV', targetType: 'NODE', nodeUUID: node.uuid,
    position: node.position, rotation: { azimuth: used[index].azimuth, polar: 0 }, zoom: 0,
    ...(captions ? { format: 'plain', text: node.label } : {}),
    files: [], models: [], annotations: [], sounds: [] })) : [];
  const bootstrap = {
    space: { id: id.sceneId, title: id.title, type: 'spaces', space_data: {
      initialNode: nodes[0].uuid, initialRotation: { azimuth: used[0].azimuth, polar: 0 }, nodes,
      navigation: { mode: 'neighbors', maxDistance: spacing * 1.5 }
    } },
    tour: { title: id.title, tour_data: { mode: guided ? 'guided' : 'explore', defaultShowText: captions,
      spaces: [{ id: id.sceneId, title: id.title, tourpoints }] } }
  };
  await writePackage({ id, kind, sourceType: kind, bootstrap, nodeCount: nodes.length, inputs, tool, notes: { skipped } });
  return { used, skipped };
}

function parseLabelsOption(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  if (raw.trim().startsWith('[')) return JSON.parse(raw);
  return raw.split(',').map(item => item.trim());
}

if (isMain(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const inputs = list(options.input);
  if (!inputs.length || !inputs.every(existsSync)) fail('Pass --input with photos or a folder of photos.');
  const id = identity(options);
  const customLabels = parseLabelsOption(options.labels);
  const { used, skipped } = await buildPanoramas(collectImages(inputs), id, {
    maxWidth: Number(options['max-width'] ?? 8192),
    captions: Boolean(options.captions) || Boolean(customLabels?.length),
    labels: customLabels,
    inputs
  });
  if (!used.length) fail(JSON.stringify({ error: 'No 2:1 equirectangular photos found.', skipped }, null, 2));
  console.log(JSON.stringify({ folder: id.folder, preview: path.join(id.folder, 'preview.jpg'), panoramas: used.length, openingAzimuth: used[0].azimuth, skipped }, null, 2));
}
