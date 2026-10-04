import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import * as THREE from "three";
import { openingSpace } from "@/lib/scene-edits";
import type { Vec3 } from "@/lib/experience/types";
import type { SphrBootstrap } from "@/lib/types";
import { parseGlb } from "./capture-mesh";

/**
 * Pictures of spaces without panoramas (Gaussian splats and 3D models), for the tour
 * agent: the space is drawn on the server from a few cameras around its start view, as
 * points for a splat (as the packager draws its preview) or as shaded triangles for a
 * model, with a depth buffer, so a pixel the agent points at becomes a point in the space.
 * Each space is drawn once and kept under SPHR_STATE_DIR/space-views.
 */

export type ViewCamera = { position: Vec3; azimuth: number; polar: number; fov: number };
export type SpaceView = { id: string; camera: ViewCamera; width: number; height: number; image: string; depth: Float32Array };

const width = 960;
const height = 640;
const fov = 60;
const pointBudget = 900_000;
const version = 1;
const cache = new Map<string, Promise<SpaceView[] | null>>();
let drawing: Promise<unknown> = Promise.resolve();

type Points = { positions: Float32Array; colors: Uint8Array; sizes: Float32Array; count: number };

// Drawing runs in the app's own process, so it gives other requests a turn every few
// milliseconds; otherwise a first draw holds every visitor for seconds.
let turnStarted = performance.now();
async function pause() {
  if (performance.now() - turnStarted < 25) return;
  await new Promise((resolve) => setImmediate(resolve));
  turnStarted = performance.now();
}
type Source = { kind: "points"; points: Points } | { kind: "triangles"; positions: Float32Array; count: number };

/** The views of a space without panoramas, drawn once; null when it has panoramas or nothing to draw. */
export function spaceViews(bootstrap: SphrBootstrap, sceneId: string): Promise<SpaceView[] | null> {
  const data = openingSpace(bootstrap).space_data;
  const panoramas = !data.noPanos && (data.nodes ?? data.navPoints ?? []).length > 0;
  if (panoramas) return Promise.resolve(null);
  const splats = (data.splats ?? []).filter((splat) => /\.(splat|ply)(\?|$)/i.test(splat.url ?? "") && fetchable(splat.url!) && splat.role === undefined);
  const graph = data.sceneGraph ?? bootstrap.tour?.tour_data?.sceneGraph ?? [];
  const models = graph.filter((node) => node.type === "model" && typeof node.file === "string" && fetchable(node.file));
  if (!splats.length && !models.length) return Promise.resolve(null);
  const key = createHash("sha256").update(JSON.stringify({ version, sceneId, splats, models: models.map((node) => [node.file, node.position, node.rotation, node.scale]),
    start: [data.initialPosition, data.initialRotation] })).digest("hex").slice(0, 24);
  let entry = cache.get(key);
  if (!entry) {
    entry = drawing.then(() => fromDisk(key)).then(async (saved) => {
      if (saved) return saved;
      const source = splats.length ? { kind: "points" as const, points: await loadSplats(splats) } : { kind: "triangles" as const, ...(await loadModels(models)) };
      return toDisk(key, await draw(source, data.initialPosition, data.initialRotation));
    });
    drawing = entry.catch(() => undefined);
    entry.catch(() => cache.delete(key));
    cache.set(key, entry);
    while (cache.size > 6) cache.delete(cache.keys().next().value!);
  }
  return entry;
}

/** The point in the space under a pixel of a view (fractions from its top left), with its surface normal. */
export function pointInView(view: SpaceView, x: number, y: number) {
  const px = Math.round(THREE.MathUtils.clamp(x, 0, 1) * (view.width - 1));
  const py = Math.round(THREE.MathUtils.clamp(y, 0, 1) * (view.height - 1));
  let best: { u: number; v: number } | null = null;
  for (let radius = 0; radius <= 12 && !best; radius++) {
    for (let dy = -radius; dy <= radius && !best; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
      const u = px + dx, v = py + dy;
      if (u >= 0 && v >= 0 && u < view.width && v < view.height && Number.isFinite(view.depth[v * view.width + u])) { best = { u, v }; break; }
    }
  }
  if (!best) return null;
  const basis = cameraBasis(view.camera);
  const at = (u: number, v: number) => {
    const depth = view.depth[THREE.MathUtils.clamp(v, 0, view.height - 1) * view.width + THREE.MathUtils.clamp(u, 0, view.width - 1)];
    if (!Number.isFinite(depth)) return null;
    return basis.origin.clone().addScaledVector(basis.forward, depth)
      .addScaledVector(basis.right, (u - view.width / 2) * depth / basis.focal(view.height))
      .addScaledVector(basis.up, (view.height / 2 - v) * depth / basis.focal(view.height));
  };
  const point = at(best.u, best.v)!;
  // The surface's normal from points a few pixels around it, facing the camera.
  const across = at(best.u + 4, best.v) ?? at(best.u - 4, best.v);
  const down = at(best.u, best.v + 4) ?? at(best.u, best.v - 4);
  let normal: THREE.Vector3 | null = null;
  if (across && down) {
    normal = across.clone().sub(point).cross(down.clone().sub(point)).normalize();
    if (normal.dot(basis.forward) > 0) normal.negate();
    if (!Number.isFinite(normal.x)) normal = null;
  }
  return { point, normal, distance: point.distanceTo(basis.origin) };
}

function cameraBasis(camera: ViewCamera) {
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(camera.polar), THREE.MathUtils.degToRad(camera.azimuth), 0, "YXZ"));
  return {
    origin: new THREE.Vector3(...camera.position),
    forward: new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion),
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion),
    focal: (h: number) => h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
  };
}

// ---- Reading splats ---------------------------------------------------------------------

type SplatConfig = { url?: string; fileType?: string; position?: Vec3 | number[]; rotation?: Vec3 | number[]; scale?: number | number[] };

async function loadSplats(splats: SplatConfig[]): Promise<Points> {
  const parts = await Promise.all(splats.map(async (splat) => {
    const points = /\.ply(\?|$)/i.test(splat.url!) || splat.fileType === "ply" ? await streamPly(splat.url!, pointBudget / splats.length) : await streamSplat(splat.url!, pointBudget / splats.length);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(...((splat.position as number[] | undefined) ?? [0, 0, 0])),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...((splat.rotation as [number, number, number] | undefined) ?? [0, 0, 0]))),
      typeof splat.scale === "number" ? new THREE.Vector3(splat.scale, splat.scale, splat.scale) : new THREE.Vector3(...((splat.scale as number[] | undefined) ?? [1, 1, 1])));
    const vector = new THREE.Vector3();
    for (let index = 0; index < points.count; index++) {
      if ((index & 4095) === 0) await pause();
      vector.fromArray(points.positions, index * 3).applyMatrix4(matrix).toArray(points.positions, index * 3);
    }
    return points;
  }));
  const count = parts.reduce((sum, part) => sum + part.count, 0);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const sizes = new Float32Array(count);
  let offset = 0;
  for (const [index, part] of parts.entries()) {
    positions.set(part.positions.subarray(0, part.count * 3), offset * 3);
    colors.set(part.colors.subarray(0, part.count * 3), offset * 3);
    const scale = typeof splats[index].scale === "number" ? splats[index].scale as number : Math.max(...((splats[index].scale as number[] | undefined) ?? [1]));
    for (let point = 0; point < part.count; point++) sizes[offset + point] = part.sizes[point] * scale;
    offset += part.count;
  }
  return { positions, colors, sizes, count };
}

/** Hands every `size`-byte record of a byte stream to `take`, keeping only every `stride`-th. */
async function streamRecords(chunks: AsyncIterable<Uint8Array>, size: number, stride: number, take: (record: DataView) => void) {
  let carry = new Uint8Array(0);
  let index = 0;
  for await (const chunk of chunks) {
    await pause();
    const bytes = carry.length ? concat(carry, chunk) : chunk;
    let offset = 0;
    for (; offset + size <= bytes.length; offset += size, index++) {
      if (index % stride === 0) take(new DataView(bytes.buffer, bytes.byteOffset + offset, size));
    }
    carry = bytes.slice(offset);
  }
}

/** Files come from the asset host, or from this site's own packages under /datasets/. */
const fetchable = (url: string) => /^https:\/\//.test(url) || (url.startsWith("/datasets/") && !url.includes(".."));

async function open(url: string): Promise<{ chunks: AsyncIterable<Uint8Array>; length: number }> {
  if (url.startsWith("/datasets/")) {
    const file = path.join(process.cwd(), "public", url.split("?")[0]);
    return { chunks: createReadStream(file) as unknown as AsyncIterable<Uint8Array>, length: (await stat(file)).size };
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) throw new Error(`The file is unavailable (HTTP ${response.status}).`);
  return { chunks: response.body as unknown as AsyncIterable<Uint8Array>, length: Number(response.headers.get("content-length") ?? 0) };
}

async function readAll(url: string) {
  const { chunks } = await open(url);
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

const concat = (a: Uint8Array, b: Uint8Array) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

/** The common 32-byte .splat rows: position, scale, color with alpha, rotation. */
async function streamSplat(url: string, budget: number): Promise<Points> {
  const file = await open(url);
  const total = Math.max(1, Math.floor(file.length / 32));
  const stride = Math.max(1, Math.ceil(total / budget));
  const capacity = Math.ceil(total / stride) + 1;
  const positions = new Float32Array(capacity * 3);
  const colors = new Uint8Array(capacity * 3);
  const sizes = new Float32Array(capacity);
  let count = 0;
  await streamRecords(file.chunks, 32, stride, (row) => {
    if (row.getUint8(27) < 30 || count >= capacity) return;
    positions[count * 3] = row.getFloat32(0, true); positions[count * 3 + 1] = row.getFloat32(4, true); positions[count * 3 + 2] = row.getFloat32(8, true);
    colors[count * 3] = row.getUint8(24); colors[count * 3 + 1] = row.getUint8(25); colors[count * 3 + 2] = row.getUint8(26);
    sizes[count] = Math.max(row.getFloat32(12, true), row.getFloat32(16, true), row.getFloat32(20, true));
    count++;
  });
  return { positions, colors, sizes, count };
}

const plySizes: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

/** Binary little-endian Gaussian splat PLY: positions, and colors from the zeroth spherical harmonic (or plain colors). */
async function streamPly(url: string, budget: number): Promise<Points> {
  const reader = (await open(url)).chunks[Symbol.asyncIterator]();
  let head = new Uint8Array(0);
  let end = -1;
  while (end < 0) {
    const { value, done } = await reader.next();
    if (done) throw new Error("The PLY file has no header.");
    head = concat(head, value);
    end = Buffer.from(head).indexOf("end_header\n");
    if (head.length > 1 << 20) throw new Error("The PLY header is too long.");
  }
  const header = Buffer.from(head.subarray(0, end)).toString("latin1").split("\n");
  if (!header.some((line) => line.startsWith("format binary_little_endian"))) throw new Error("Only binary little-endian PLY splats are read.");
  let total = 0;
  let inVertex = false;
  const properties: { name: string; type: string; offset: number }[] = [];
  let size = 0;
  for (const line of header) {
    const words = line.trim().split(/\s+/);
    if (words[0] === "element") { inVertex = words[1] === "vertex"; if (inVertex) total = Number(words[2]); }
    else if (words[0] === "property" && inVertex && words[1] !== "list") { properties.push({ name: words[2], type: words[1], offset: size }); size += plySizes[words[1]] ?? 4; }
  }
  const field = (name: string) => properties.find((property) => property.name === name);
  const [x, y, z] = ["x", "y", "z"].map(field);
  if (!x || !y || !z || !size || !total) throw new Error("The PLY file has no splat positions.");
  const harmonics = ["f_dc_0", "f_dc_1", "f_dc_2"].map(field);
  const plain = ["red", "green", "blue"].map(field);
  const opacity = field("opacity");
  const scales = ["scale_0", "scale_1", "scale_2"].map(field).filter((property): property is NonNullable<typeof property> => Boolean(property));
  const stride = Math.max(1, Math.ceil(total / budget));
  const capacity = Math.ceil(total / stride) + 1;
  const positions = new Float32Array(capacity * 3);
  const colors = new Uint8Array(capacity * 3);
  const sizes = new Float32Array(capacity);
  let count = 0;
  const read = (row: DataView, property: { type: string; offset: number }) => property.type === "uchar" || property.type === "uint8" ? row.getUint8(property.offset) / 255 : row.getFloat32(property.offset, true);
  // The rows start right after the header, partway through the chunk that held its end.
  const leftover = head.subarray(end + "end_header\n".length);
  const rows = (async function* () { yield leftover; for (let next = await reader.next(); !next.done; next = await reader.next()) yield next.value; })();
  await streamRecords(rows, size, stride, (row) => {
      if (count >= capacity) return;
      if (opacity && 1 / (1 + Math.exp(-row.getFloat32(opacity.offset, true))) < 0.15) return;
      positions[count * 3] = read(row, x); positions[count * 3 + 1] = read(row, y); positions[count * 3 + 2] = read(row, z);
      for (let channel = 0; channel < 3; channel++) {
        const value = harmonics[channel] ? 0.5 + 0.28209479 * row.getFloat32(harmonics[channel]!.offset, true) : plain[channel] ? read(row, plain[channel]!) : 0.6;
        colors[count * 3 + channel] = Math.round(THREE.MathUtils.clamp(value, 0, 1) * 255);
      }
      sizes[count] = scales.length ? Math.exp(Math.max(...scales.map((property) => row.getFloat32(property.offset, true)))) : 0.01;
      count++;
    });
  return { positions, colors, sizes, count };
}

// ---- Reading models ---------------------------------------------------------------------

type ModelNode = { file?: string; position?: unknown; rotation?: unknown; scale?: unknown };

async function loadModels(models: ModelNode[]) {
  const pieces: Float32Array[] = [];
  for (const node of models) {
    const parts = await parseGlb(await readAll(node.file!));
    const holder = new THREE.Object3D();
    if (Array.isArray(node.position)) holder.position.fromArray(node.position as number[]);
    if (Array.isArray(node.rotation)) holder.rotation.set(...(node.rotation as [number, number, number]));
    if (typeof node.scale === "number") holder.scale.setScalar(node.scale); else if (Array.isArray(node.scale)) holder.scale.fromArray(node.scale as number[]);
    holder.updateMatrix();
    const vector = new THREE.Vector3();
    for (const part of parts) {
      const matrix = holder.matrix.clone().multiply(part.matrix);
      const position = part.geometry.attributes.position.array as Float32Array;
      const index = part.geometry.index?.array;
      const corners = index ? index.length : position.length / 3;
      const piece = new Float32Array(corners * 3);
      for (let corner = 0; corner < corners; corner++) {
        if ((corner & 4095) === 0) await pause();
        vector.fromArray(position, (index ? index[corner] : corner) * 3).applyMatrix4(matrix).toArray(piece, corner * 3);
      }
      pieces.push(piece);
    }
  }
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  if (!total) throw new Error("The model has no triangles to draw.");
  const positions = new Float32Array(total);
  let offset = 0;
  for (const piece of pieces) { positions.set(piece, offset); offset += piece.length; }
  return { positions, count: total / 9 };
}

// ---- Drawing ----------------------------------------------------------------------------

/**
 * Places to look from: the start view, turning in place from it, orbiting the middle of the
 * space at the start view's distance, and an overview from above.
 */
function candidateCameras(source: Source, start: { x: number; y: number; z: number } | undefined, rotation: { azimuth: number; polar: number } | undefined): ViewCamera[] {
  const positions = source.kind === "points" ? source.points.positions.subarray(0, source.points.count * 3) : source.positions;
  // A robust box around most of the space: 3rd to 97th percentile on each axis.
  const sample = (axis: number) => {
    const values: number[] = [];
    const step = Math.max(1, Math.floor(positions.length / 3 / 20000));
    for (let index = 0; index < positions.length / 3; index += step) values.push(positions[index * 3 + axis]);
    values.sort((a, b) => a - b);
    return [values[Math.floor(values.length * 0.03)], values[Math.floor(values.length * 0.97)]];
  };
  const [[minX, maxX], [minY, maxY], [minZ, maxZ]] = [0, 1, 2].map(sample);
  const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.5);
  const eye = start ? new THREE.Vector3(start.x, start.y, start.z) : center.clone().add(new THREE.Vector3(0, size * 0.3, size * 1.2));
  const turn = rotation ?? { azimuth: 0, polar: -15 };
  const aim = (from: THREE.Vector3, to: THREE.Vector3) => {
    const toward = to.clone().sub(from).normalize();
    return { azimuth: THREE.MathUtils.radToDeg(Math.atan2(-toward.x, -toward.z)), polar: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(toward.y, -1, 1))) };
  };
  const at = (point: THREE.Vector3) => [point.x, point.y, point.z] as Vec3;
  const turns = [0, 90, 180, 270].map((degrees) => ({ position: at(eye), azimuth: turn.azimuth + degrees, polar: degrees ? THREE.MathUtils.clamp(turn.polar, -20, 5) : turn.polar, fov }));
  // Orbit at the start view's distance, but never from inside the middle of the space.
  let offset = eye.clone().sub(center);
  if (offset.length() < size * 0.45) offset = new THREE.Vector3(0, size * 0.35, size * 0.8).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(turn.azimuth));
  const orbits = [45, 135, 225, 315].map((degrees) => {
    const from = center.clone().add(offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(degrees)));
    return { position: at(from), ...aim(from, center), fov };
  });
  const above = center.clone().add(new THREE.Vector3(0, size * 0.7, 0).add(offset.clone().setY(0).setLength(size * 0.6)));
  return [...turns, ...orbits, { position: at(above), ...aim(above, center), fov }];
}

/** The start view, then the three views that show the most of the space and look different from it. */
async function draw(source: Source, start: { x: number; y: number; z: number } | undefined, rotation: { azimuth: number; polar: number } | undefined) {
  const rendered = [];
  for (const camera of candidateCameras(source, start, rotation)) {
    const image = source.kind === "points" ? await drawPoints(source.points, camera) : await drawTriangles(source.positions, source.count, camera);
    let filled = 0;
    for (let cell = 0; cell < image.depth.length; cell++) if (Number.isFinite(image.depth[cell])) filled++;
    rendered.push({ camera, ...image, coverage: filled / image.depth.length });
    await pause();
  }
  const direction = (camera: ViewCamera) => new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(THREE.MathUtils.degToRad(camera.polar), THREE.MathUtils.degToRad(camera.azimuth), 0, "YXZ"));
  const chosen = [rendered[0]];
  for (const candidate of rendered.slice(1).sort((a, b) => b.coverage - a.coverage)) {
    if (chosen.length >= 4 || candidate.coverage < 0.12) continue;
    const alike = chosen.some((view) => direction(view.camera).angleTo(direction(candidate.camera)) < THREE.MathUtils.degToRad(40)
      && new THREE.Vector3(...view.camera.position).distanceTo(new THREE.Vector3(...candidate.camera.position)) < 0.5);
    if (!alike) chosen.push(candidate);
  }
  return chosen.map(({ camera, rgb, depth }, index) => ({ id: `s${index + 1}`, camera, width, height, rgb, depth }));
}

async function drawPoints(points: Points, camera: ViewCamera) {
  const basis = cameraBasis(camera);
  const focal = basis.focal(height);
  const rgb = new Uint8Array(width * height * 3).fill(32);
  const depth = new Float32Array(width * height).fill(Infinity);
  const { origin, forward, right, up } = basis;
  for (let index = 0; index < points.count; index++) {
    if ((index & 4095) === 0) await pause();
    const dx = points.positions[index * 3] - origin.x, dy = points.positions[index * 3 + 1] - origin.y, dz = points.positions[index * 3 + 2] - origin.z;
    const z = dx * forward.x + dy * forward.y + dz * forward.z;
    if (z < 0.1) continue;
    const u = Math.round(width / 2 + focal * (dx * right.x + dy * right.y + dz * right.z) / z);
    const v = Math.round(height / 2 - focal * (dx * up.x + dy * up.y + dz * up.z) / z);
    // A splat covers about its own size on screen (sampled splats a little more), at least a pixel.
    const radius = Math.min(6, Math.max(0, Math.round(focal * points.sizes[index] * 1.2 / z)));
    for (let oy = -radius; oy <= radius; oy++) for (let ox = -radius; ox <= radius; ox++) {
      const px = u + ox, py = v + oy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const cell = py * width + px;
      if (z >= depth[cell]) continue;
      depth[cell] = z;
      rgb[cell * 3] = points.colors[index * 3]; rgb[cell * 3 + 1] = points.colors[index * 3 + 1]; rgb[cell * 3 + 2] = points.colors[index * 3 + 2];
    }
  }
  await fillHoles(rgb, depth, 2);
  return { rgb, depth };
}

/** Flat-shaded triangles with a depth buffer: a clay render of a model. */
async function drawTriangles(positions: Float32Array, count: number, camera: ViewCamera) {
  const basis = cameraBasis(camera);
  const focal = basis.focal(height);
  const rgb = new Uint8Array(width * height * 3).fill(32);
  const depth = new Float32Array(width * height).fill(Infinity);
  const light = new THREE.Vector3(0.4, 0.8, 0.45).normalize();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3();
  const project = (point: THREE.Vector3) => {
    const d = point.clone().sub(basis.origin);
    const z = d.dot(basis.forward);
    return { x: width / 2 + focal * d.dot(basis.right) / z, y: height / 2 - focal * d.dot(basis.up) / z, z };
  };
  for (let triangle = 0; triangle < count; triangle++) {
    if ((triangle & 255) === 0) await pause();
    a.fromArray(positions, triangle * 9); b.fromArray(positions, triangle * 9 + 3); c.fromArray(positions, triangle * 9 + 6);
    const [pa, pb, pc] = [project(a), project(b), project(c)];
    if (pa.z < 0.05 || pb.z < 0.05 || pc.z < 0.05) continue;
    normal.copy(b).sub(a).cross(c.clone().sub(a)).normalize();
    const shade = 0.35 + 0.65 * Math.abs(normal.dot(light));
    const tone = [Math.round(205 * shade), Math.round(196 * shade), Math.round(180 * shade)];
    const minX = Math.max(0, Math.floor(Math.min(pa.x, pb.x, pc.x))), maxX = Math.min(width - 1, Math.ceil(Math.max(pa.x, pb.x, pc.x)));
    const minY = Math.max(0, Math.floor(Math.min(pa.y, pb.y, pc.y))), maxY = Math.min(height - 1, Math.ceil(Math.max(pa.y, pb.y, pc.y)));
    const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
    if (Math.abs(area) < 1e-9 || maxX < minX || maxY < minY) continue;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const w0 = ((pb.x - x) * (pc.y - y) - (pc.x - x) * (pb.y - y)) / area;
      const w1 = ((pc.x - x) * (pa.y - y) - (pa.x - x) * (pc.y - y)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = 1 / (w0 / pa.z + w1 / pb.z + w2 / pc.z);
      const cell = y * width + x;
      if (z >= depth[cell]) continue;
      depth[cell] = z;
      rgb[cell * 3] = tone[0]; rgb[cell * 3 + 1] = tone[1]; rgb[cell * 3 + 2] = tone[2];
    }
  }
  return { rgb, depth };
}

/** Fills pinholes between points from their nearest neighbors, a few passes. */
async function fillHoles(rgb: Uint8Array, depth: Float32Array, passes: number) {
  for (let pass = 0; pass < passes; pass++) {
    const next = depth.slice();
    for (let y = 1; y < height - 1; y++) {
      if ((y & 31) === 0) await pause();
      for (let x = 1; x < width - 1; x++) {
      const cell = y * width + x;
      if (Number.isFinite(depth[cell])) continue;
      let best = -1, near = Infinity, found = 0;
      for (const offset of [-1, 1, -width, width, -width - 1, -width + 1, width - 1, width + 1]) {
        const value = depth[cell + offset];
        if (Number.isFinite(value)) { found++; if (value < near) { near = value; best = cell + offset; } }
      }
      if (found < 3 || best < 0) continue;
      next[cell] = near;
      rgb[cell * 3] = rgb[best * 3]; rgb[cell * 3 + 1] = rgb[best * 3 + 1]; rgb[cell * 3 + 2] = rgb[best * 3 + 2];
      }
    }
    depth.set(next);
  }
}

// ---- Keeping them -----------------------------------------------------------------------

const folder = (key: string) => process.env.SPHR_STATE_DIR ? path.join(process.env.SPHR_STATE_DIR, "space-views", key) : null;

async function fromDisk(key: string): Promise<SpaceView[] | null> {
  const dir = folder(key);
  if (!dir) return null;
  try {
    const meta = JSON.parse(await readFile(path.join(dir, "views.json"), "utf8")) as { views: Omit<SpaceView, "image" | "depth">[] };
    return await Promise.all(meta.views.map(async (view) => {
      const depthBytes = await readFile(path.join(dir, `${view.id}.depth`));
      return { ...view, image: (await readFile(path.join(dir, `${view.id}.jpg`))).toString("base64"),
        depth: new Float32Array(depthBytes.buffer.slice(depthBytes.byteOffset, depthBytes.byteOffset + depthBytes.byteLength)) };
    }));
  } catch { return null; }
}

async function toDisk(key: string, drawn: (Omit<SpaceView, "image"> & { rgb: Uint8Array })[]): Promise<SpaceView[]> {
  const views = await Promise.all(drawn.map(async ({ rgb, ...view }) => ({ ...view,
    image: (await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), { raw: { width: view.width, height: view.height, channels: 3 } }).jpeg({ quality: 82 }).toBuffer()).toString("base64") })));
  const dir = folder(key);
  if (dir) {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (const view of views) {
        await writeFile(path.join(dir, `${view.id}.jpg`), Buffer.from(view.image, "base64"), { mode: 0o600 });
        await writeFile(path.join(dir, `${view.id}.depth`), Buffer.from(view.depth.buffer, view.depth.byteOffset, view.depth.byteLength), { mode: 0o600 });
      }
      await writeFile(path.join(dir, "views.json.tmp"), JSON.stringify({ views: views.map(({ id, camera, width: w, height: h }) => ({ id, camera, width: w, height: h })) }), { mode: 0o600 });
      await rename(path.join(dir, "views.json.tmp"), path.join(dir, "views.json"));
    } catch (failure) { console.warn("Unable to keep the space's views:", (failure as Error).message); }
  }
  return views;
}
