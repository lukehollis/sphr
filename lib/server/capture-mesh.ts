import { readFile } from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import { normalizeTour } from "@/lib/bootstrap";
import { applyTransform } from "@/lib/three/math";
import type { SceneGraphNode, SphrBootstrap } from "@/lib/types";

/**
 * A space's capture meshes (scene graph models marked `raycast`) as plain triangles in
 * world space, so the server can place what an agent points at the way the viewer
 * does: by casting rays against the captured surfaces. Only positions and indices are
 * read, from plain or Draco-compressed glTF binaries; textures are skipped.
 */

const maxBytes = 160 * 1024 * 1024;
const kept = 4;
const lifetime = 30 * 60 * 1000;
const cache = new Map<string, { at: number; parts: Promise<MeshPart[]> }>();
const surface = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

type MeshPart = { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 };
type Gltf = {
  scene?: number; scenes?: { nodes?: number[] }[];
  nodes?: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; mode?: number; extensions?: { KHR_draco_mesh_compression?: { bufferView: number; attributes: Record<string, number> } } }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
};

/** World-space meshes to raycast against, or none when the space has no capture mesh. */
export async function captureMeshes(bootstrap: SphrBootstrap): Promise<THREE.Mesh[]> {
  // Meshes come from the asset host, or from this site's own packages under /datasets/.
  const onSite = (file: string) => file.startsWith("/datasets/") && !file.includes("..");
  const meshes: THREE.Mesh[] = [];
  const visit = async (node: SceneGraphNode, parent: THREE.Matrix4) => {
    const local = new THREE.Object3D();
    applyTransform(local, node);
    local.updateMatrix();
    const world = parent.clone().multiply(local.matrix);
    if (node.type === "group") for (const child of node.children ?? []) await visit(child, world);
    if (node.type !== "model" || !node.raycast || !node.file || !(/^https:\/\//.test(node.file) || onSite(node.file))) return;
    for (const part of await meshParts(node.file)) {
      const mesh = new THREE.Mesh(part.geometry, surface);
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorld.copy(world.clone().multiply(part.matrix));
      meshes.push(mesh);
    }
  };
  for (const node of normalizeTour(bootstrap).sceneGraph ?? []) await visit(node, new THREE.Matrix4());
  return meshes;
}

function meshParts(url: string) {
  const now = Date.now();
  for (const [key, entry] of cache) if (now - entry.at > lifetime) cache.delete(key);
  let entry = cache.get(url);
  if (!entry) {
    entry = { at: now, parts: download(url).then(parseGlb) };
    entry.parts.catch(() => cache.delete(url));
    cache.set(url, entry);
    while (cache.size > kept) cache.delete(cache.keys().next().value!);
  }
  return entry.parts;
}

async function download(url: string) {
  if (url.startsWith("/datasets/")) {
    const bytes = await readFile(path.join(process.cwd(), "public", url.split("?")[0]));
    if (bytes.length > maxBytes) throw new Error("The capture mesh is too large to place against.");
    return bytes;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!response.ok || !response.body) throw new Error(`The capture mesh is unavailable (HTTP ${response.status}).`);
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error("The capture mesh is too large to place against.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    length += chunk.length;
    if (length > maxBytes) throw new Error("The capture mesh is too large to place against.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Positions and indices of every triangle primitive in a GLB, with each node's matrix. */
export async function parseGlb(bytes: Buffer): Promise<MeshPart[]> {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw new Error("The capture mesh is not a glTF binary.");
  let gltf: Gltf | null = null;
  let bin: Buffer | null = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) gltf = JSON.parse(chunk.toString("utf8"));
    else if (type === 0x004e4942) bin = chunk;
    offset += 8 + length;
  }
  if (!gltf || !bin) throw new Error("The capture mesh has no geometry.");
  const view = (index: number) => {
    const entry = gltf!.bufferViews![index];
    return { bytes: bin!.subarray(entry.byteOffset ?? 0, (entry.byteOffset ?? 0) + entry.byteLength), stride: entry.byteStride };
  };
  const parts: MeshPart[] = [];
  const walk = async (index: number, parent: THREE.Matrix4) => {
    const node = gltf!.nodes?.[index];
    if (!node) return;
    const local = new THREE.Matrix4();
    if (node.matrix) local.fromArray(node.matrix);
    else local.compose(new THREE.Vector3(...(node.translation ?? [0, 0, 0])), new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(node.scale ?? [1, 1, 1])));
    const matrix = parent.clone().multiply(local);
    for (const primitive of node.mesh === undefined ? [] : gltf!.meshes?.[node.mesh]?.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const draco = primitive.extensions?.KHR_draco_mesh_compression;
      const geometry = new THREE.BufferGeometry();
      if (draco) {
        const decoded = await decodeDraco(view(draco.bufferView).bytes, draco.attributes.POSITION);
        geometry.setAttribute("position", new THREE.BufferAttribute(decoded.positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(decoded.indices, 1));
      } else {
        geometry.setAttribute("position", new THREE.BufferAttribute(readAccessor(gltf!, primitive.attributes.POSITION, view) as Float32Array, 3));
        if (primitive.indices !== undefined) geometry.setIndex(new THREE.BufferAttribute(readAccessor(gltf!, primitive.indices, view, true), 1));
      }
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      parts.push({ geometry, matrix });
    }
    for (const child of node.children ?? []) await walk(child, matrix);
  };
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  for (const index of scene?.nodes ?? gltf.nodes?.map((_, i) => i) ?? []) await walk(index, new THREE.Matrix4());
  return parts;
}

const componentArrays: Record<number, { array: typeof Float32Array | typeof Uint32Array | typeof Uint16Array | typeof Uint8Array | typeof Int16Array | typeof Int8Array; normalize: number }> = {
  5126: { array: Float32Array, normalize: 1 }, 5125: { array: Uint32Array, normalize: 4294967295 }, 5123: { array: Uint16Array, normalize: 65535 },
  5121: { array: Uint8Array, normalize: 255 }, 5122: { array: Int16Array, normalize: 32767 }, 5120: { array: Int8Array, normalize: 127 }
};
const sizes: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** One accessor as floats (positions) or 32-bit integers (indices), following strides and normalization. */
function readAccessor(gltf: Gltf, index: number, view: (index: number) => { bytes: Buffer; stride?: number }, integers = false): Float32Array | Uint32Array {
  const accessor = gltf.accessors![index];
  const kind = componentArrays[accessor.componentType];
  if (!kind || accessor.bufferView === undefined) throw new Error("The capture mesh uses an unsupported accessor.");
  const size = sizes[accessor.type] ?? 1;
  const { bytes, stride } = view(accessor.bufferView);
  const element = kind.array.BYTES_PER_ELEMENT;
  const step = stride ?? size * element;
  const out = integers ? new Uint32Array(accessor.count * size) : new Float32Array(accessor.count * size);
  const data = new DataView(bytes.buffer, bytes.byteOffset + (accessor.byteOffset ?? 0));
  const read = (offset: number) => {
    switch (accessor.componentType) {
      case 5126: return data.getFloat32(offset, true);
      case 5125: return data.getUint32(offset, true);
      case 5123: return data.getUint16(offset, true);
      case 5121: return data.getUint8(offset);
      case 5122: return data.getInt16(offset, true);
      default: return data.getInt8(offset);
    }
  };
  const scale = accessor.normalized && !integers ? 1 / kind.normalize : 1;
  for (let item = 0; item < accessor.count; item++) {
    for (let component = 0; component < size; component++) out[item * size + component] = read(item * step + component * element) * scale;
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dracoModule: Promise<any> | null = null;

async function decodeDraco(data: Buffer, positionId: number) {
  dracoModule ??= (async () => {
    const draco3d = await import("draco3dgltf");
    // Hand it the wasm directly: bundled servers do not always keep the package's own path.
    const wasmBinary = await readFile(path.join(process.cwd(), "node_modules/draco3dgltf/draco_decoder_gltf.wasm")).catch(() => undefined);
    return (draco3d.default ?? draco3d).createDecoderModule(wasmBinary ? { wasmBinary } : {});
  })();
  dracoModule.catch(() => { dracoModule = null; });
  const draco = await dracoModule;
  const decoder = new draco.Decoder();
  const buffer = new draco.DecoderBuffer();
  const mesh = new draco.Mesh();
  try {
    buffer.Init(new Int8Array(data.buffer, data.byteOffset, data.byteLength), data.byteLength);
    if (decoder.GetEncodedGeometryType(buffer) !== draco.TRIANGULAR_MESH) throw new Error("The capture mesh's Draco data is not a triangle mesh.");
    const status = decoder.DecodeBufferToMesh(buffer, mesh);
    if (!status.ok() || mesh.ptr === 0) throw new Error(`The capture mesh could not be decoded: ${status.error_msg()}`);
    const faces = mesh.num_faces();
    const points = mesh.num_points();
    const indexBytes = faces * 3 * 4;
    const indexPointer = draco._malloc(indexBytes);
    decoder.GetTrianglesUInt32Array(mesh, indexBytes, indexPointer);
    const indices = new Uint32Array(draco.HEAPF32.buffer, indexPointer, faces * 3).slice();
    draco._free(indexPointer);
    const attribute = decoder.GetAttributeByUniqueId(mesh, positionId);
    const positionBytes = points * 3 * 4;
    const positionPointer = draco._malloc(positionBytes);
    decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, draco.DT_FLOAT32, positionBytes, positionPointer);
    const positions = new Float32Array(draco.HEAPF32.buffer, positionPointer, points * 3).slice();
    draco._free(positionPointer);
    return { positions, indices };
  } finally {
    draco.destroy(mesh);
    draco.destroy(buffer);
    draco.destroy(decoder);
  }
}
