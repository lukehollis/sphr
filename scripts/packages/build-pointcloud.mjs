#!/usr/bin/env node
// Packages a lidar point cloud (LAS/LAZ, E57 without panoramas, PLY/PCD points, XYZ/PTS)
// as a splat space, each point a small round splat.
//   node scripts/packages/build-pointcloud.mjs --input scan.laz --title "Title" [--up z|y] [--max-points 4000000] [--interior] [--elevation 35]
// E57 exports that include panoramic images are better as panorama spaces: try the Matterport
// importer first (sphr-matterport skill), which works for any E57 with registered images.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, identity, parseArgs } from './common.mjs';
import { packageSplat } from './splat-package.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const python = [process.env.SPHR_MATTERPORT_PYTHON, path.join(root, '.venv-matterport/bin/python'), path.join(root, '../.venv-matterport/bin/python')]
  .find(candidate => candidate && existsSync(candidate)) ?? 'python3';

const options = parseArgs(process.argv.slice(2));
const input = options.input;
if (typeof input !== 'string' || !existsSync(input)) fail('Pass --input with a point cloud file.');
const id = identity(options);
const work = mkdtempSync(path.join(tmpdir(), 'sphr-points-'));
try {
  const output = path.join(work, 'scene.splat');
  const converted = spawnSync(python, [path.join(root, 'scripts/packages/pointcloud_to_splat.py'), '--input', input, '--output', output,
    '--max-points', String(options['max-points'] ?? 4000000), ...(options.up ? ['--up', options.up] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (converted.status !== 0) fail('The point cloud could not be converted.');
  const conversion = JSON.parse(converted.stdout.trim().split('\n').pop());
  const result = await packageSplat(output, id, { kind: 'pointcloud', tool: 'build-pointcloud', inputs: [input], interior: Boolean(options.interior),
    elevation: Number(options.elevation ?? 35), notes: { conversion } });
  console.log(JSON.stringify({ ...result, conversion }, null, 2));
} finally { rmSync(work, { recursive: true, force: true }); }
