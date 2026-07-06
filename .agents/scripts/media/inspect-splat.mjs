#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const target = process.argv[2];

if (!target) {
  console.error("Usage: node .claude/scripts/media/inspect-splat.mjs <asset.splat|asset.ksplat>");
  process.exit(1);
}

function isLikelyLegacy(view, byteLength) {
  if (byteLength < 1024) return false;
  const compression = view.getUint8(3);
  const count = view.getUint32(4, true);
  const bucketSize = view.getUint32(8, true);
  const bucketCount = view.getUint32(12, true);
  const bytesPerBucket = view.getUint32(20, true);
  const bytesPerSplat = compression === 0 ? 44 : compression === 1 ? 24 : 0;
  if (!bytesPerSplat || !count || !bucketSize || !bucketCount) return false;
  const required = 1024 + count * bytesPerSplat + bucketCount * bytesPerBucket;
  return required <= byteLength;
}

function sampleStandard(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.byteLength / 32;
  const step = Math.max(1, Math.floor(count / 10000));
  const posMin = [Infinity, Infinity, Infinity];
  const posMax = [-Infinity, -Infinity, -Infinity];
  const scaleMin = [Infinity, Infinity, Infinity];
  const scaleMax = [-Infinity, -Infinity, -Infinity];
  let alphaMin = 255;
  let alphaMax = 0;
  for (let index = 0; index < count; index += step) {
    const offset = index * 32;
    for (let i = 0; i < 3; i++) {
      const pos = view.getFloat32(offset + i * 4, true);
      const scale = view.getFloat32(offset + 12 + i * 4, true);
      posMin[i] = Math.min(posMin[i], pos);
      posMax[i] = Math.max(posMax[i], pos);
      scaleMin[i] = Math.min(scaleMin[i], scale);
      scaleMax[i] = Math.max(scaleMax[i], scale);
    }
    alphaMin = Math.min(alphaMin, bytes[offset + 27]);
    alphaMax = Math.max(alphaMax, bytes[offset + 27]);
  }
  return { count, posMin, posMax, scaleMin, scaleMax, alphaMin, alphaMax };
}

const absolute = path.resolve(root, target);
const bytes = await readFile(absolute);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const result = {
  path: path.relative(root, absolute),
  bytes: bytes.byteLength,
  standardSplat: bytes.byteLength % 32 === 0,
  likelyLegacyGaussianSplats3D: isLikelyLegacy(view, bytes.byteLength)
};

if (result.standardSplat) {
  result.sample = sampleStandard(bytes);
}

if (result.likelyLegacyGaussianSplats3D) {
  result.legacyHeader = {
    version: `${view.getUint8(0)}.${view.getUint8(1)}`,
    compression: view.getUint8(3),
    splatCount: view.getUint32(4, true),
    bucketSize: view.getUint32(8, true),
    bucketCount: view.getUint32(12, true),
    bucketBlockSize: view.getFloat32(16, true),
    bytesPerBucket: view.getUint32(20, true)
  };
}

console.log(JSON.stringify(result, null, 2));
