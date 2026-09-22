#!/usr/bin/env node
// Identifies what each uploaded file is, so the intake agent can choose a pipeline.
//   node scripts/packages/inspect-inputs.mjs <file or folder>... [--extract <folder>]
// Prints JSON: one entry per file with its kind, key measurements and a suggested tool.
// ZIP archives are listed; with --extract they are unpacked (safely) and their contents inspected.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { parseArgs } from './common.mjs';
import { plyHeader } from './splat-reader.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const python = [process.env.SPHR_MATTERPORT_PYTHON, path.join(root, '.venv-matterport/bin/python'), path.join(root, '../.venv-matterport/bin/python')]
  .find(candidate => candidate && existsSync(candidate)) ?? 'python3';

function head(file, bytes = 16) {
  const buffer = Buffer.alloc(Math.min(bytes, statSync(file).size));
  const handle = openSync(file, 'r');
  try { readSync(handle, buffer, 0, buffer.length, 0); } finally { closeSync(handle); }
  return buffer;
}

function py(code, ...args) {
  const result = spawnSync(python, ['-c', code, ...args], { encoding: 'utf8', timeout: 600000 });
  return result.status === 0 ? JSON.parse(result.stdout.trim().split('\n').pop()) : { error: (result.stderr || '').trim().split('\n').pop() };
}

function probe(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  const data = JSON.parse(result.stdout);
  const video = data.streams.find(stream => stream.codec_type === 'video');
  if (!video) return undefined;
  const spherical = Boolean(video.side_data_list?.some(item => /spherical/i.test(item.side_data_type ?? '')));
  return { width: video.width, height: video.height, seconds: Number(data.format.duration ?? 0), codec: video.codec_name, spherical,
    equirectangular: Math.abs(video.width / video.height - 2) < 0.1 };
}

async function inspect(file) {
  const bytes = statSync(file).size;
  const name = path.basename(file), extension = path.extname(file).slice(1).toLowerCase();
  const base = { file, name, bytes };
  const magic = head(file);
  if (magic.subarray(0, 4).toString('latin1') === 'PK' || extension === 'zip') {
    const listing = spawnSync('python3', ['-c', 'import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps([[i.filename,i.file_size] for i in z.infolist() if not i.is_dir()][:2000]))', file], { encoding: 'utf8' });
    const entries = listing.status === 0 ? JSON.parse(listing.stdout) : [];
    return { ...base, kind: 'zip', entries: entries.length, sample: entries.slice(0, 40), hint: 'Unpack with --extract, then inspect the contents. Matterport exports are ZIPs containing an E57.' };
  }
  if (extension === 'e57' || magic.subarray(0, 8).toString('latin1') === 'ASTM-E57') {
    const info = py('import pye57,sys,json\ne=pye57.E57(sys.argv[1]);r=e.root\nimages=len(r["images2D"]) if r.isDefined("images2D") else 0\nprint(json.dumps({"scans":e.scan_count,"images":images}))', file);
    return { ...base, kind: 'e57', ...info, tool: info.images ? 'npm run import:matterport (sphr-matterport skill)' : 'scripts/packages/build-pointcloud.mjs',
      hint: info.images ? 'E57 with panoramic images: import as calibrated panoramas.' : 'E57 without images: package as a point cloud.' };
  }
  if (['las', 'laz'].includes(extension)) return { ...base, kind: 'pointcloud', format: extension, tool: 'scripts/packages/build-pointcloud.mjs' };
  if (['xyz', 'pts', 'pcd'].includes(extension)) return { ...base, kind: 'pointcloud', format: extension, tool: 'scripts/packages/build-pointcloud.mjs' };
  if (extension === 'ply') {
    const header = plyHeader(file);
    if (!header) return { ...base, kind: 'unknown', hint: 'PLY header not readable.' };
    if (header.gaussian) return { ...base, kind: 'splat', format: 'ply', splats: header.vertices, tool: 'scripts/packages/build-splat.mjs' };
    if (header.faces) return { ...base, kind: 'mesh', format: 'ply', vertices: header.vertices, faces: header.faces, tool: 'scripts/packages/build-model.mjs' };
    return { ...base, kind: 'pointcloud', format: 'ply', points: header.vertices, colored: header.colored, tool: 'scripts/packages/build-pointcloud.mjs' };
  }
  if (['spz', 'splat', 'ksplat', 'sog', 'rad'].includes(extension)) return { ...base, kind: 'splat', format: extension, tool: 'scripts/packages/build-splat.mjs' };
  if (['obj', 'glb', 'gltf', 'stl', 'usdz', 'usd', 'usdc', 'usda', 'fbx', 'dae', '3ds'].includes(extension)) {
    return { ...base, kind: 'mesh', format: extension, tool: 'scripts/packages/build-model.mjs' };
  }
  if (['mtl', 'bin'].includes(extension)) return { ...base, kind: 'mesh-part', hint: 'Keep next to its OBJ or glTF file.' };
  if (/^(jpe?g|png|webp|tiff?|heic|heif|avif|dng)$/.test(extension)) {
    try {
      const meta = await sharp(file).metadata();
      const [width, height] = meta.orientation >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
      const equirect = Math.abs(width / height - 2) < 0.1;
      return { ...base, kind: equirect ? 'panorama' : 'photo', width, height,
        tool: equirect ? 'scripts/packages/build-panoramas.mjs' : 'photogrammetry (sphr-video skill, photo set)' };
    } catch (error) { return { ...base, kind: 'image', error: error.message }; }
  }
  const video = probe(file);
  if (video) return { ...base, kind: video.equirectangular || video.spherical ? 'video360' : 'video', ...video,
    tool: video.equirectangular ? 'scripts/packages/build-video360.mjs' : 'sphr-video skill (reconstruction)' };
  return { ...base, kind: 'unknown', magic: magic.toString('hex') };
}

function walk(input) {
  return statSync(input).isDirectory()
    ? readdirSync(input).filter(name => !name.startsWith('.') && name !== '__MACOSX').flatMap(name => walk(path.join(input, name)))
    : [input];
}

const options = parseArgs(process.argv.slice(2));
const results = [];
for (const file of options._.flatMap(walk)) {
  const result = await inspect(file);
  results.push(result);
  if (result.kind === 'zip' && typeof options.extract === 'string') {
    const target = path.join(options.extract, path.basename(file).replace(/\.zip$/i, ''));
    mkdirSync(target, { recursive: true });
    // Python's extractor refuses absolute paths and ".." members.
    const unpacked = spawnSync('python3', ['-c', `import zipfile,sys,os
z=zipfile.ZipFile(sys.argv[1]);t=os.path.realpath(sys.argv[2])
for i in z.infolist():
  p=os.path.realpath(os.path.join(t,i.filename))
  if not p.startswith(t+os.sep) and p!=t: raise SystemExit('unsafe member '+i.filename)
z.extractall(t)`, file, target], { encoding: 'utf8' });
    result.extracted = unpacked.status === 0 ? target : { error: unpacked.stderr.trim() };
    if (unpacked.status === 0) for (const inner of walk(target)) results.push({ ...(await inspect(inner)), from: result.name });
  }
}
const kinds = results.reduce((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }), {});
console.log(JSON.stringify({ kinds, files: results }, null, 2));
