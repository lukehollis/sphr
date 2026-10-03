#!/usr/bin/env node
// Checks the GaussianSplats3D SplatBuffer converter on a small hand-built file.
//   node scripts/test-legacy-splat.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { convertLegacySplat, legacySplatHeader } from './packages/legacy-splat.mjs';

function toHalf(value) {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, value);
  const bits = buffer.getUint32(0);
  const sign = (bits >>> 16) & 0x8000, exponent = ((bits >>> 23) & 0xff) - 127 + 15, fraction = (bits >>> 13) & 0x3ff;
  if (exponent <= 0) return sign;
  return sign | (exponent << 10) | fraction;
}

const folder = mkdtempSync(path.join(tmpdir(), 'legacy-splat-'));
try {
  // Two buckets of two splats, compression level 1.
  const splats = [
    { center: [1, 2, 3], scale: [0.5, 0.25, 0.125], color: [255, 0, 0, 255], rotation: [1, 0, 0, 0] },
    { center: [1.5, 2, 3], scale: [0.1, 0.1, 0.1], color: [0, 255, 0, 200], rotation: [0, 1, 0, 0] },
    { center: [-4, 0, 0], scale: [1, 1, 1], color: [0, 0, 255, 0], rotation: [1, 0, 0, 0] },
    { center: [-4.5, 0.5, 0], scale: [0.2, 0.2, 0.2], color: [9, 9, 9, 255], rotation: [0.5, 0.5, 0.5, 0.5] }
  ];
  const buckets = [[1, 2, 3], [-4, 0, 0]], blockSize = 5, range = 32767, factor = blockSize / 2 / range;
  const header = Buffer.alloc(1024);
  header[3] = 1;
  header.writeUInt32LE(splats.length, 4);
  header.writeUInt32LE(2, 8);
  header.writeUInt32LE(buckets.length, 12);
  header.writeFloatLE(blockSize, 16);
  header.writeUInt32LE(12, 20);
  header.writeUInt32LE(range, 24);
  const centers = Buffer.alloc(splats.length * 6), scales = Buffer.alloc(splats.length * 6);
  const colors = Buffer.alloc(splats.length * 4), rotations = Buffer.alloc(splats.length * 8), bucketData = Buffer.alloc(buckets.length * 12);
  splats.forEach((splat, index) => {
    const bucket = buckets[Math.floor(index / 2)];
    splat.center.forEach((value, axis) => centers.writeUInt16LE(Math.round((value - bucket[axis]) / factor + range), (index * 3 + axis) * 2));
    splat.scale.forEach((value, axis) => scales.writeUInt16LE(toHalf(value), (index * 3 + axis) * 2));
    Buffer.from(splat.color).copy(colors, index * 4);
    splat.rotation.forEach((value, part) => rotations.writeUInt16LE(toHalf(value), (index * 4 + part) * 2));
  });
  buckets.forEach((bucket, index) => bucket.forEach((value, axis) => bucketData.writeFloatLE(value, (index * 3 + axis) * 4)));
  const legacy = path.join(folder, 'legacy.splat');
  writeFileSync(legacy, Buffer.concat([header, centers, scales, colors, rotations, bucketData]));

  assert.ok(legacySplatHeader(legacy), 'the SplatBuffer is recognised');
  const output = path.join(folder, 'standard.splat');
  const result = convertLegacySplat(legacy, output);
  assert.deepEqual(result, { total: 4, written: 3 }, 'the fully transparent splat is dropped');
  const rows = readFileSync(output);
  assert.equal(rows.length, 3 * 32);
  assert.equal(legacySplatHeader(output), null, 'standard rows are not mistaken for a SplatBuffer');
  const kept = splats.filter(splat => splat.color[3] > 0);
  kept.forEach((splat, row) => {
    const at = row * 32;
    splat.center.forEach((value, axis) => assert.ok(Math.abs(rows.readFloatLE(at + axis * 4) - value) < 1e-3, `centre ${row}`));
    splat.scale.forEach((value, axis) => assert.ok(Math.abs(rows.readFloatLE(at + 12 + axis * 4) - value) < value * 1e-3, `scale ${row}`));
    assert.deepEqual([...rows.subarray(at + 24, at + 28)], splat.color);
    splat.rotation.forEach((value, part) => assert.ok(Math.abs(rows[at + 28 + part] - (value * 128 + 128)) <= 1, `rotation ${row}`));
  });
  console.log('legacy splat: conversion ok');
} finally {
  rmSync(folder, { recursive: true, force: true });
}
