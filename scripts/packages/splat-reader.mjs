// Reads positions and colors from Gaussian splat files for bounds and previews.
// PLY (3DGS or colored points) and standard .splat rows are parsed; other formats
// (.spz, .sog, .ksplat, .rad) are served as they are and previewed by title only.
import { closeSync, openSync, readSync, statSync } from 'node:fs';

const sizes = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
const readers = {
  char: 'getInt8', int8: 'getInt8', uchar: 'getUint8', uint8: 'getUint8', short: 'getInt16', int16: 'getInt16', ushort: 'getUint16', uint16: 'getUint16',
  int: 'getInt32', int32: 'getInt32', uint: 'getUint32', uint32: 'getUint32', float: 'getFloat32', float32: 'getFloat32', double: 'getFloat64', float64: 'getFloat64'
};

function readHead(file, bytes = 65536) {
  const handle = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(bytes, statSync(file).size));
    readSync(handle, buffer, 0, buffer.length, 0);
    return buffer;
  } finally { closeSync(handle); }
}

/** PLY header: vertex count, properties with byte offsets, and whether faces exist (a mesh). */
export function plyHeader(file) {
  const head = readHead(file);
  const end = head.indexOf('end_header\n');
  if (!head.subarray(0, 4).toString().startsWith('ply') || end < 0) return undefined;
  const lines = head.subarray(0, end).toString('latin1').split('\n');
  const format = lines.find(line => line.startsWith('format '))?.split(' ')[1];
  let element = '', vertices = 0, faces = 0, stride = 0;
  const properties = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'element') { element = parts[1]; if (element === 'vertex') vertices = Number(parts[2]); if (element === 'face') faces = Number(parts[2]); }
    if (parts[0] === 'property' && element === 'vertex' && parts[1] !== 'list') {
      properties.push({ type: parts[1], name: parts[2], offset: stride });
      stride += sizes[parts[1]] ?? 0;
    }
  }
  const names = new Set(properties.map(property => property.name));
  return { format, vertices, faces, stride, properties, dataStart: end + 'end_header\n'.length,
    gaussian: names.has('f_dc_0') && names.has('opacity') && names.has('scale_0'), colored: names.has('red') };
}

/** Samples up to `limit` splats: positions (Float32 xyz) and sRGB colors (Uint8 rgb). */
export function sampleSplats(file, limit = 400000) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.ply')) {
    const header = plyHeader(file);
    if (!header || header.format !== 'binary_little_endian' || !header.stride) return undefined;
    const property = name => header.properties.find(item => item.name === name);
    const [x, y, z] = ['x', 'y', 'z'].map(property);
    if (!x || !y || !z) return undefined;
    const dc = ['f_dc_0', 'f_dc_1', 'f_dc_2'].map(property), rgb = ['red', 'green', 'blue'].map(property), opacity = property('opacity');
    const step = Math.max(1, Math.floor(header.vertices / limit));
    const count = Math.ceil(header.vertices / step);
    const positions = new Float32Array(count * 3), colors = new Uint8Array(count * 3);
    const handle = openSync(file, 'r');
    const row = Buffer.alloc(header.stride);
    let kept = 0;
    try {
      for (let index = 0; index < header.vertices; index += step) {
        readSync(handle, row, 0, header.stride, header.dataStart + index * header.stride);
        const view = new DataView(row.buffer, row.byteOffset, row.byteLength);
        const value = item => view[readers[item.type]](item.offset, true);
        if (opacity && 1 / (1 + Math.exp(-value(opacity))) < 0.2) continue;
        positions.set([value(x), value(y), value(z)], kept * 3);
        const color = dc.every(Boolean) ? dc.map(item => Math.max(0, Math.min(255, (0.5 + 0.28209479 * value(item)) * 255)))
          : rgb.every(Boolean) ? rgb.map(item => value(item) * (item.type.includes('float') ? 255 : 1)) : [200, 200, 200];
        colors.set(color, kept * 3);
        kept++;
      }
    } finally { closeSync(handle); }
    return { total: header.vertices, positions: positions.subarray(0, kept * 3), colors: colors.subarray(0, kept * 3), gaussian: header.gaussian };
  }
  if (lower.endsWith('.splat')) {
    const total = Math.floor(statSync(file).size / 32);
    const step = Math.max(1, Math.floor(total / limit));
    const count = Math.ceil(total / step);
    const positions = new Float32Array(count * 3), colors = new Uint8Array(count * 3);
    const handle = openSync(file, 'r');
    const row = Buffer.alloc(32);
    let kept = 0;
    try {
      for (let index = 0; index < total; index += step) {
        readSync(handle, row, 0, 32, index * 32);
        if (row[27] < 50) continue;
        positions.set([row.readFloatLE(0), row.readFloatLE(4), row.readFloatLE(8)], kept * 3);
        colors.set([row[24], row[25], row[26]], kept * 3);
        kept++;
      }
    } finally { closeSync(handle); }
    return { total, positions: positions.subarray(0, kept * 3), colors: colors.subarray(0, kept * 3), gaussian: true };
  }
  return undefined;
}
