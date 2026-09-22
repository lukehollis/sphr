#!/usr/bin/env node
// Packages a scanned or photogrammetry mesh (OBJ, GLB/glTF, PLY, STL, USDZ, FBX…) as a model space
// the visitor can orbit.
//   node scripts/packages/build-model.mjs --input scan.obj --title "Title" [--up y|z] [--max-faces 1500000] [--lit]
// Textured scans render unlit so their baked lighting shows as captured; --lit adds scene lights
// for plain or vertex-colored meshes (the default for untextured models).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bounds, fail, freshFolder, identity, orbitCamera, parseArgs, pointPreview, startPoint, writePackage } from './common.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const python = [process.env.SPHR_MATTERPORT_PYTHON, path.join(root, '.venv-matterport/bin/python'), path.join(root, '../.venv-matterport/bin/python')]
  .find(candidate => candidate && existsSync(candidate)) ?? 'python3';

const options = parseArgs(process.argv.slice(2));
const input = options.input;
if (typeof input !== 'string' || !existsSync(input)) fail('Pass --input with a mesh file.');
const id = identity(options);
const work = mkdtempSync(path.join(tmpdir(), 'sphr-model-'));
try {
  freshFolder(id.folder);
  mkdirSync(path.join(id.folder, 'model'));
  const glb = path.join(id.folder, 'model/scene.glb'), samples = path.join(work, 'points.bin');
  const converted = spawnSync(python, [path.join(root, 'scripts/packages/mesh_to_glb.py'), '--input', input, '--output', glb, '--points', samples,
    '--max-faces', String(options['max-faces'] ?? 1500000), ...(options.up ? ['--up', options.up] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (converted.status !== 0) fail('The mesh could not be converted.');
  const conversion = JSON.parse(converted.stdout.trim().split('\n').pop());
  const data = readFileSync(samples);
  const count = data.length / 15;
  const positions = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + count * 12));
  const colors = new Uint8Array(data.buffer.slice(data.byteOffset + count * 12, data.byteOffset + count * 15));
  const box = bounds(positions);
  const camera = orbitCamera(box, { elevation: Number(options.elevation ?? 25) });
  await pointPreview(positions, colors, box, path.join(id.folder, 'preview.jpg'), camera);
  const lit = Boolean(options.lit) || !conversion.textured;
  const bootstrap = {
    space: { id: id.sceneId, title: id.title, type: 'splat', space_data: { noPanos: true, initialPosition: camera.position, initialRotation: camera.rotation } },
    tour: { title: id.title, tour_data: { mode: 'explore',
      sceneGraph: [
        { id: 'model', type: 'model', file: `${id.datasetUrl}/model/scene.glb`, fileType: 'glb', persistent: true, visible: true, unlit: !lit },
        ...(lit ? [{ id: 'ambient', type: 'ambientLight', intensity: 1.2, persistent: true }, { id: 'sun', type: 'directionalLight', intensity: 2, position: [4, 8, 6], persistent: true }] : [])
      ],
      spaces: [{ id: id.sceneId, title: id.title, tourpoints: [startPoint(camera)] }] } }
  };
  const manifest = await writePackage({ id, kind: 'model', bootstrap, inputs: [input], tool: 'build-model', notes: { conversion } });
  console.log(JSON.stringify({ folder: id.folder, preview: path.join(id.folder, 'preview.jpg'), files: manifest.files.length, conversion, camera }, null, 2));
} finally { rmSync(work, { recursive: true, force: true }); }
