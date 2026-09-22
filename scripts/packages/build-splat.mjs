#!/usr/bin/env node
// Packages one Gaussian splat (.ply, .spz, .splat, .ksplat, .sog) as an SPHR space.
//   node scripts/packages/build-splat.mjs --input scene.ply --title "Title" [--rotation 180,0,0] [--interior] [--elevation 25]
// Scene ID, slug and output folder come from the job (SPHR_SCENE_ID, SPHR_SCENE_SLUG, SPHR_JOB_DIR)
// or --scene-id, --slug and --public-root. Look at preview.jpg: if the capture is upside down or
// sideways, rebuild with --rotation (degrees about x,y,z). Many 3DGS trainers need 180,0,0.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fail, identity, parseArgs, parseRotation } from './common.mjs';
import { packageSplat } from './splat-package.mjs';

const options = parseArgs(process.argv.slice(2));
const input = options.input;
if (typeof input !== 'string' || !existsSync(input)) fail('Pass --input with a splat file.');
if (!/\.(ply|spz|splat|ksplat|sog|rad)$/i.test(input)) fail(`Unsupported splat format: ${path.extname(input)}`);
const result = await packageSplat(input, identity(options), { rotation: parseRotation(options.rotation), interior: Boolean(options.interior),
  elevation: options.elevation !== undefined ? Number(options.elevation) : undefined, distance: options.distance !== undefined ? Number(options.distance) : undefined });
console.log(JSON.stringify(result, null, 2));
