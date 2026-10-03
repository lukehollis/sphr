#!/usr/bin/env node
// Packages one Gaussian splat (.ply, .spz, .splat, .ksplat, .sog) as an SPHR space.
//   node scripts/packages/build-splat.mjs --input scene.ply --title "Title" [--cameras work/colmap/sparse/0] [--rotation 180,0,0 | --no-level] [--interior] [--elevation 25]
// Scene ID, slug and output folder come from the job (SPHR_SCENE_ID, SPHR_SCENE_SLUG, SPHR_JOB_DIR)
// or --scene-id, --slug and --public-root. The capture is leveled on its ground plane automatically;
// look at preview.jpg, and if it is still upside down or sideways, rebuild with --rotation (degrees
// about x,y,z), which replaces the automatic leveling. --cameras points at the COLMAP model the splat was
// trained from: the capture is then leveled by the cameras' up direction and opens from a capture position,
// orbiting what the cameras looked at, or standing at the start of a walkthrough.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fail, identity, parseArgs, parseRotation } from './common.mjs';
import { readColmapCameras } from './colmap-cameras.mjs';
import { packageSplat } from './splat-package.mjs';

const options = parseArgs(process.argv.slice(2));
const input = options.input;
if (typeof input !== 'string' || !existsSync(input)) fail('Pass --input with a splat file.');
if (!/\.(ply|spz|splat|ksplat|sog|rad)$/i.test(input)) fail(`Unsupported splat format: ${path.extname(input)}`);
if (options.cameras !== undefined && (typeof options.cameras !== 'string' || !existsSync(options.cameras))) fail('--cameras takes a COLMAP model folder (with images.bin).');
const cameras = options.cameras ? readColmapCameras(options.cameras) : undefined;
const result = await packageSplat(input, identity(options), { rotation: options.rotation === undefined ? undefined : parseRotation(options.rotation), cameras,
  level: !options['no-level'], interior: Boolean(options.interior),
  elevation: options.elevation !== undefined ? Number(options.elevation) : undefined, distance: options.distance !== undefined ? Number(options.distance) : undefined });
console.log(JSON.stringify(result, null, 2));
