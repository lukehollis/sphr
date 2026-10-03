// Early GaussianSplats3D viewers (2023, including old SPHR scenes) saved splats as a compressed "SplatBuffer"
// with a .splat extension. Spark reads only the standard 32-byte .splat rows, so these are converted.
//
// SplatBuffer 0.0: a 1024-byte header, then every splat's centre, then every scale, colour and rotation
// (planar arrays), then one float32 centre per bucket. Compression level 1 stores centres as uint16 offsets
// from their bucket's centre and scales and rotations as half floats; level 0 stores float32 throughout.
import { closeSync, openSync, readSync, statSync, writeSync } from 'node:fs';

const HEADER = 1024;
const LEVELS = { 0: { center: 12, scale: 12, color: 4, rotation: 16 }, 1: { center: 6, scale: 6, color: 4, rotation: 8 } };

/** The SplatBuffer header of `file`, or null when it is not one (a standard .splat, for example). */
export function legacySplatHeader(file) {
  const size = statSync(file).size;
  if (size < HEADER) return null;
  const handle = openSync(file, 'r');
  const header = Buffer.alloc(HEADER);
  try { readSync(handle, header, 0, HEADER, 0); } finally { closeSync(handle); }
  const [major, minor, , level] = header;
  if (major !== 0 || minor !== 0 || !LEVELS[level]) return null;
  const splats = header.readUInt32LE(4), bucketSize = header.readUInt32LE(8), buckets = header.readUInt32LE(12);
  const blockSize = header.readFloatLE(16), bytesPerBucket = header.readUInt32LE(20), scaleRange = header.readUInt32LE(24) || 32767;
  const layout = LEVELS[level];
  const perSplat = layout.center + layout.scale + layout.color + layout.rotation;
  // The sizes must add up exactly; a standard .splat whose first floats happen to look like a header will not.
  if (!splats || size !== HEADER + splats * perSplat + buckets * bytesPerBucket) return null;
  if (level > 0 && (!bucketSize || buckets * bucketSize < splats || bytesPerBucket !== 12 || !(blockSize > 0))) return null;
  return { level, splats, bucketSize, buckets, blockSize, bytesPerBucket, scaleRange, layout };
}

function halfToFloat(value) {
  const sign = value & 0x8000 ? -1 : 1, exponent = (value >> 10) & 0x1f, fraction = value & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/**
 * Writes `input` (a SplatBuffer) as standard .splat rows to `output`. Splats fainter than `minAlpha` (0–255)
 * are dropped; `maxSplats` keeps the most opaque and largest ones. Returns { total, written }.
 */
export function convertLegacySplat(input, output, { minAlpha = 1, maxSplats = Infinity } = {}) {
  const header = legacySplatHeader(input);
  if (!header) throw new Error(`${input} is not a GaussianSplats3D SplatBuffer`);
  const { level, splats, bucketSize, scaleRange, blockSize, layout } = header;
  const handle = openSync(input, 'r');
  const read = (offset, length) => { const buffer = Buffer.alloc(length); readSync(handle, buffer, 0, length, offset); return buffer; };
  let centers, scales, colors, rotations, bucketCenters;
  try {
    const base = HEADER;
    centers = read(base, splats * layout.center);
    scales = read(base + splats * layout.center, splats * layout.scale);
    colors = read(base + splats * (layout.center + layout.scale), splats * layout.color);
    rotations = read(base + splats * (layout.center + layout.scale + layout.color), splats * layout.rotation);
    bucketCenters = level > 0 ? read(base + splats * (layout.center + layout.scale + layout.color + layout.rotation), header.buckets * 12) : null;
  } finally { closeSync(handle); }
  const factor = blockSize / 2 / scaleRange;
  const component = (buffer, index) => (level > 0 ? halfToFloat(buffer.readUInt16LE(index * 2)) : buffer.readFloatLE(index * 4));
  let order = [];
  for (let index = 0; index < splats; index++) if (colors[index * 4 + 3] >= minAlpha) order.push(index);
  if (order.length > maxSplats) {
    const weight = index => colors[index * 4 + 3] * Math.abs(component(scales, index * 3) * component(scales, index * 3 + 1) * component(scales, index * 3 + 2));
    order = order.map(index => [weight(index), index]).sort((a, b) => b[0] - a[0]).slice(0, maxSplats).map(([, index]) => index);
  }
  const rows = Buffer.alloc(order.length * 32);
  order.forEach((index, row) => {
    const at = row * 32;
    for (let axis = 0; axis < 3; axis++) {
      const position = level > 0
        ? (centers.readUInt16LE((index * 3 + axis) * 2) - scaleRange) * factor + bucketCenters.readFloatLE((Math.floor(index / bucketSize) * 3 + axis) * 4)
        : centers.readFloatLE((index * 3 + axis) * 4);
      rows.writeFloatLE(position, at + axis * 4);
      rows.writeFloatLE(component(scales, index * 3 + axis), at + 12 + axis * 4);
    }
    colors.copy(rows, at + 24, index * 4, index * 4 + 4);
    // Rotations are stored w, x, y, z, as standard .splat rows expect; rows hold them as bytes around 128.
    const q = [0, 1, 2, 3].map(part => component(rotations, index * 4 + part));
    const length = Math.hypot(...q) || 1;
    q.forEach((value, part) => { rows[at + 28 + part] = Math.max(0, Math.min(255, Math.round(value / length * 128 + 128))); });
  });
  const out = openSync(output, 'w');
  try { writeSync(out, rows); } finally { closeSync(out); }
  return { total: splats, written: order.length };
}
