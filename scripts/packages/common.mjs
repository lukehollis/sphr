// Shared helpers for building SPHR packages (schema "sphr-package-v1") from captures that
// are not Matterport E57 exports: Gaussian splats, 360 photos and video, point clouds and meshes.
//
// A package is a folder served at /datasets/matterport/<slug>/ containing bootstrap.json,
// preview.jpg, manifest.json (every runtime file with its SHA-256) and validation.json.
// Build tools write the runtime files, then call writePackage(); validate-package.mjs checks
// the result. The processing runner validates again with its own copy before publishing.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const schema = 'sphr-package-v1';
export const previewSize = { width: 960, height: 640 };

/** --name value pairs; repeated names collect into arrays; bare --flags become true. */
export function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith('--')) { options._.push(item); continue; }
    const [name, inline] = item.slice(2).split(/=(.*)/s);
    const value = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true);
    options[name] = options[name] === undefined ? value : [].concat(options[name], value);
  }
  return options;
}

export const list = value => value === undefined ? [] : [].concat(value);

/** True when the module at `url` is the script being run (paths compared after resolving links). */
export function isMain(url) {
  return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Scene ID, storage slug, title and output folder. A processing job provides them through
 * SPHR_SCENE_ID, SPHR_SCENE_SLUG and SPHR_JOB_DIR; arguments override them.
 */
export function identity(options, title) {
  const sceneId = options['scene-id'] ?? process.env.SPHR_SCENE_ID;
  const slug = options.slug ?? process.env.SPHR_SCENE_SLUG;
  const publicRoot = options['public-root'] ?? (process.env.SPHR_JOB_DIR ? path.join(process.env.SPHR_JOB_DIR, 'output/public') : undefined);
  const name = String(options.title ?? title ?? '').trim();
  if (!/^[a-f0-9]{12}$/.test(sceneId ?? '')) fail('Pass --scene-id (12 hex characters) or set SPHR_SCENE_ID.');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? '')) fail('Pass --slug (lowercase letters, digits and dashes) or set SPHR_SCENE_SLUG.');
  if (!publicRoot) fail('Pass --public-root or set SPHR_JOB_DIR.');
  if (!name || name.length > 200) fail('Pass --title (1–200 characters).');
  const folder = path.join(path.resolve(publicRoot), 'datasets/matterport', slug);
  const datasetUrl = `/datasets/matterport/${slug}`;
  return { sceneId, slug, title: name, folder, datasetUrl };
}

/** Starts an empty package folder, replacing an earlier attempt. */
export function freshFolder(folder) {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  return folder;
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

function runtimeFiles(folder, prefix = '') {
  return readdirSync(path.join(folder, prefix)).sort().flatMap(name => {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path.join(folder, relative));
    if (stat.isSymbolicLink()) fail(`Packages cannot contain links: ${relative}`);
    if (stat.isDirectory()) return runtimeFiles(folder, relative);
    return ['manifest.json', 'validation.json'].includes(relative) ? [] : [relative];
  });
}

/**
 * Writes bootstrap.json and manifest.json. Every other file already in the folder is a
 * runtime file and is listed with its hash, so nothing unlisted can be published.
 */
export async function writePackage({ id, kind, sourceType, bootstrap, nodeCount = 0, inputs = [], tool, notes }) {
  writeFileSync(path.join(id.folder, 'bootstrap.json'), JSON.stringify(bootstrap, null, 2) + '\n');
  if (!existsSync(path.join(id.folder, 'preview.jpg'))) fail('Write preview.jpg before the manifest.');
  const files = [];
  for (const relative of runtimeFiles(id.folder)) {
    const file = path.join(id.folder, relative);
    files.push({ path: relative, bytes: lstatSync(file).size, sha256: await sha256File(file) });
  }
  const manifest = { schema, sceneId: id.sceneId, slug: id.slug, title: id.title, kind, sourceType: sourceType ?? kind,
    datasetUrl: id.datasetUrl, bootstrapUrl: `${id.datasetUrl}/bootstrap.json`, nodeCount, createdAt: new Date().toISOString(),
    tool, inputs: inputs.map(input => ({ name: path.basename(input), bytes: existsSync(input) ? lstatSync(input).size : null })),
    ...(notes ? { notes } : {}), files };
  writeFileSync(path.join(id.folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// ---- Previews ----

const paper = { r: 17, g: 17, b: 17 };

/** A dark graph-paper sheet, the same idiom as the viewer's loading screen. */
function graphPaper(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const major = x % 80 === 0 || y % 80 === 0, minor = x % 16 === 0 || y % 16 === 0;
      const shade = major ? 44 : minor ? 27 : paper.r;
      const offset = (y * width + x) * 3;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = shade;
    }
  }
  return pixels;
}

export async function titlePreview(title, out) {
  const { width, height } = previewSize;
  const escaped = title.replace(/[<>&"]/g, character => `&#${character.charCodeAt(0)};`);
  const label = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="48" y="${height - 56}" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700" fill="#f2f1ed">${escaped}</text></svg>`);
  await sharp(graphPaper(width, height), { raw: { width, height, channels: 3 } }).composite([{ input: label }]).jpeg({ quality: 88 }).toFile(out);
}

/** Robust bounds from sampled positions: 2nd–98th percentile box, ignoring stray floaters. */
export function bounds(positions) {
  const count = positions.length / 3;
  const axis = offset => {
    const values = new Float32Array(count);
    for (let index = 0; index < count; index++) values[index] = positions[index * 3 + offset];
    values.sort();
    return [values[Math.floor(count * 0.02)], values[Math.floor(count * 0.5)], values[Math.min(count - 1, Math.floor(count * 0.98))]];
  };
  const [x, y, z] = [axis(0), axis(1), axis(2)];
  const min = { x: x[0], y: y[0], z: z[0] }, max = { x: x[2], y: y[2], z: z[2] };
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const radius = Math.max(0.5, Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2);
  return { min, max, center, radius, median: { x: x[1], y: y[1], z: z[1] } };
}

/**
 * Camera for looking at a capture from outside: in front of its bounds, slightly above,
 * aimed at the center. Rotation is the viewer's azimuth/polar in degrees, where polar is
 * the elevation of the view direction (0 = level, negative = looking down).
 */
export function orbitCamera(box, { elevation = 25, distance = 2.1 } = {}) {
  const pitch = elevation * Math.PI / 180;
  const range = box.radius * distance;
  const position = { x: box.center.x, y: box.center.y + Math.sin(pitch) * range, z: box.center.z + Math.cos(pitch) * range };
  return { position, rotation: { azimuth: 0, polar: -elevation }, target: box.center, distance: range };
}

/** The opening view of a space without panoramas, as an explore-mode tour point. */
export function startPoint(camera) {
  const orbit = camera.distance !== undefined;
  return { id: 'start', viewMode: orbit ? 'ORBIT' : 'FPV', targetType: 'FREE', position: orbit ? camera.target : camera.position,
    rotation: camera.rotation, ...(orbit ? { distance: camera.distance } : {}), zoom: 0, files: [], models: [], annotations: [], sounds: [] };
}

/** Renders colored points with a simple depth buffer, looking down -z from the orbit camera. */
export async function pointPreview(positions, colors, box, out, camera = orbitCamera(box)) {
  const { width, height } = previewSize;
  const pixels = graphPaper(width, height);
  const depths = new Float32Array(width * height).fill(Infinity);
  const pitch = -camera.rotation.polar * Math.PI / 180;
  const cos = Math.cos(pitch), sin = Math.sin(pitch);
  const focal = height / (2 * Math.tan(30 * Math.PI / 180));
  const count = positions.length / 3;
  const size = count > 400000 ? 1 : count > 100000 ? 2 : 3;
  for (let index = 0; index < count; index++) {
    const dx = positions[index * 3] - camera.position.x;
    const dy = positions[index * 3 + 1] - camera.position.y;
    const dz = positions[index * 3 + 2] - camera.position.z;
    // Camera looks down by the pitch: forward (0, -sin, -cos), up (0, cos, -sin).
    const cy = dy * cos - dz * sin, depth = -dy * sin - dz * cos;
    if (depth <= 0.05) continue;
    const u = Math.round(width / 2 + focal * dx / depth), v = Math.round(height / 2 - focal * cy / depth);
    for (let oy = 0; oy < size; oy++) for (let ox = 0; ox < size; ox++) {
      const px = u + ox, py = v + oy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const cell = py * width + px;
      if (depth >= depths[cell]) continue;
      depths[cell] = depth;
      pixels[cell * 3] = colors[index * 3]; pixels[cell * 3 + 1] = colors[index * 3 + 1]; pixels[cell * 3 + 2] = colors[index * 3 + 2];
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toFile(out);
}

/** Rotates positions in place by Euler angles (radians, XYZ order), as the viewer applies them. */
export function rotatePositions(positions, [rx, ry, rz]) {
  if (!rx && !ry && !rz) return positions;
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  // Matrix for Three.js Euler order XYZ: R = Rx * Ry * Rz.
  const m = [cy * cz, -cy * sz, sy,
    cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy,
    sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy];
  for (let index = 0; index < positions.length; index += 3) {
    const [x, y, z] = [positions[index], positions[index + 1], positions[index + 2]];
    positions[index] = m[0] * x + m[1] * y + m[2] * z;
    positions[index + 1] = m[3] * x + m[4] * y + m[5] * z;
    positions[index + 2] = m[6] * x + m[7] * y + m[8] * z;
  }
  return positions;
}

export function parseRotation(value) {
  if (value === undefined || value === true) return [0, 0, 0];
  const parts = String(value).split(',').map(part => Number(part.trim()) * Math.PI / 180);
  if (parts.length !== 3 || parts.some(Number.isNaN)) fail('--rotation takes three angles in degrees, e.g. 180,0,0');
  return parts;
}

/**
 * Points in the dense body of a capture. Gaussian splat trainers leave stray floaters and a
 * sparse far background; framing and leveling use only well-supported regions.
 */
export function denseCore(positions, keepFraction = 0.6) {
  const count = positions.length / 3;
  const percentile = (offset, q) => {
    const values = new Float32Array(count);
    for (let index = 0; index < count; index++) values[index] = positions[index * 3 + offset];
    values.sort();
    return values[Math.min(count - 1, Math.floor(count * q))];
  };
  const low = [0, 1, 2].map(axis => percentile(axis, 0.01)), high = [0, 1, 2].map(axis => percentile(axis, 0.99));
  const size = Math.max(...high.map((value, axis) => value - low[axis])) / 48 || 1;
  const cells = 49, counts = new Uint32Array(cells ** 3), keys = new Int32Array(count).fill(-1);
  for (let index = 0; index < count; index++) {
    const cell = [0, 1, 2].map(axis => Math.floor((positions[index * 3 + axis] - low[axis]) / size));
    if (cell.some(value => value < 0 || value >= cells)) continue;
    keys[index] = cell[0] + cell[1] * cells + cell[2] * cells * cells;
    counts[keys[index]]++;
  }
  const densities = Array.from(keys).filter(key => key >= 0).map(key => counts[key]).sort((a, b) => a - b);
  const threshold = densities[Math.floor(densities.length * (1 - keepFraction))] ?? 0;
  const kept = [];
  for (let index = 0; index < count; index++) {
    if (keys[index] >= 0 && counts[keys[index]] >= threshold) kept.push(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
  }
  return kept.length >= 300 ? Float32Array.from(kept) : positions;
}

/** Euler angles (radians, XYZ order as the viewer applies them) of the shortest rotation taking `up` to +Y. */
function eulerTurningToUp([ux, uy, uz]) {
  let axis = [-uz, 0, ux]; // up × Y
  let angle = Math.acos(Math.max(-1, Math.min(1, uy)));
  const length = Math.hypot(...axis);
  if (length < 1e-9) axis = [1, 0, 0]; else axis = axis.map(value => value / length);
  const [x, y, z] = axis, c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const m = [[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c]];
  const ry = Math.asin(Math.max(-1, Math.min(1, m[0][2])));
  return Math.abs(m[0][2]) < 0.9999999
    ? [Math.atan2(-m[1][2], m[2][2]), ry, Math.atan2(-m[0][1], m[0][0])]
    : [Math.atan2(m[2][1], m[1][1]), ry, 0];
}

/**
 * Levels a capture: finds the dominant ground plane in its dense core and returns the
 * rotation that makes it horizontal. Up is the side the scene extends into (trees, walls,
 * furniture); the other side of a ground holds only a thin layer of noise. Returns null
 * when no clear ground exists (a single object, for example).
 */
export function levelRotation(positions) {
  const core = denseCore(positions);
  const count = core.length / 3;
  if (count < 1000) return null;
  let seed = 7;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const step = Math.max(1, Math.floor(count / 40000));
  let extent = 0;
  for (let axis = 0; axis < 3; axis++) {
    let low = Infinity, high = -Infinity;
    for (let index = axis; index < core.length; index += 3 * step) { low = Math.min(low, core[index]); high = Math.max(high, core[index]); }
    extent = Math.max(extent, high - low);
  }
  const tolerance = extent * 0.01;
  let best = { inliers: 0, normal: null, origin: null };
  for (let attempt = 0; attempt < 500; attempt++) {
    const [a, b, c] = [0, 1, 2].map(() => Math.floor(random() * count) * 3);
    const u = [core[b] - core[a], core[b + 1] - core[a + 1], core[b + 2] - core[a + 2]];
    const v = [core[c] - core[a], core[c + 1] - core[a + 1], core[c + 2] - core[a + 2]];
    let normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal);
    if (length < 1e-9) continue;
    normal = normal.map(value => value / length);
    let inliers = 0;
    for (let index = 0; index < core.length; index += 3 * step) {
      const distance = (core[index] - core[a]) * normal[0] + (core[index + 1] - core[a + 1]) * normal[1] + (core[index + 2] - core[a + 2]) * normal[2];
      if (Math.abs(distance) < tolerance) inliers++;
    }
    if (inliers > best.inliers) best = { inliers, normal, origin: [core[a], core[a + 1], core[a + 2]] };
  }
  const sampled = Math.ceil(count / step);
  if (!best.normal || best.inliers / sampled < 0.12) return null;
  // Compare how far the scene reaches on each side of the plane.
  const above = [], below = [];
  const all = positions.length / 3, stride = Math.max(1, Math.floor(all / 100000));
  for (let index = 0; index < positions.length; index += 3 * stride) {
    const distance = (positions[index] - best.origin[0]) * best.normal[0] + (positions[index + 1] - best.origin[1]) * best.normal[1]
      + (positions[index + 2] - best.origin[2]) * best.normal[2];
    if (distance > tolerance) above.push(distance); else if (distance < -tolerance) below.push(-distance);
  }
  const p90 = values => values.length ? values.sort((x, y) => x - y)[Math.floor(values.length * 0.9)] : 0;
  const up = p90(above) >= p90(below) ? best.normal : best.normal.map(value => -value);
  if (up[1] > Math.cos(2 * Math.PI / 180)) return { rotation: [0, 0, 0], up, ground: best.inliers / sampled };
  return { rotation: eulerTurningToUp(up), up, ground: best.inliers / sampled };
}
