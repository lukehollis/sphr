#!/usr/bin/env node
// Converts an old GaussianSplats3D compressed .splat (SplatBuffer) into standard .splat rows Spark can read.
//   node scripts/convert-legacy-splat.mjs <legacy.splat> <output.splat> [--max-splats=N] [--min-alpha=N]
import { convertLegacySplat } from './packages/legacy-splat.mjs';

const [input, output, ...flags] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node scripts/convert-legacy-splat.mjs <legacy.splat> <output.splat> [--max-splats=N] [--min-alpha=N]');
  process.exit(1);
}
const option = name => { const flag = flags.find(value => value.startsWith(`--${name}=`)); return flag ? Number(flag.split('=')[1]) : undefined; };
try {
  const result = convertLegacySplat(input, output, { maxSplats: option('max-splats') ?? Infinity, minAlpha: option('min-alpha') ?? 1 });
  console.log(`Wrote ${result.written} of ${result.total} splats to ${output}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
