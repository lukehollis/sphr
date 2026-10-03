#!/usr/bin/env node
// Checks the COLMAP camera reader and the opening views it gives splats, on synthetic orbits and walks.
//   node scripts/test-colmap-cameras.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cameraLevelRotation, cameraStartView, cameraUp, readColmapCameras, readColmapPoints } from './packages/colmap-cameras.mjs';
import { rotatePositions, viewDirection } from './packages/common.mjs';

const sub = (a, b) => a.map((value, axis) => value - b[axis]);
const unit = a => a.map(value => value / Math.hypot(...a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A COLMAP images.txt line for a camera at `center` looking along `forward` with `up` up (world axes). */
function imageLine(id, name, center, forward, up) {
  const z = unit(forward);
  const along = up[0] * z[0] + up[1] * z[1] + up[2] * z[2];
  const y = unit(up.map((value, axis) => -(value - along * z[axis]))), x = cross(y, z);
  const r = [x, y, z]; // world-to-camera rows
  const trace = r[0][0] + r[1][1] + r[2][2];
  let w, qx, qy, qz;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    [w, qx, qy, qz] = [0.25 / s, (r[2][1] - r[1][2]) * s, (r[0][2] - r[2][0]) * s, (r[1][0] - r[0][1]) * s];
  } else if (r[0][0] > r[1][1] && r[0][0] > r[2][2]) {
    const s = 2 * Math.sqrt(1 + r[0][0] - r[1][1] - r[2][2]);
    [w, qx, qy, qz] = [(r[2][1] - r[1][2]) / s, 0.25 * s, (r[0][1] + r[1][0]) / s, (r[0][2] + r[2][0]) / s];
  } else if (r[1][1] > r[2][2]) {
    const s = 2 * Math.sqrt(1 + r[1][1] - r[0][0] - r[2][2]);
    [w, qx, qy, qz] = [(r[0][2] - r[2][0]) / s, (r[0][1] + r[1][0]) / s, 0.25 * s, (r[1][2] + r[2][1]) / s];
  } else {
    const s = 2 * Math.sqrt(1 + r[2][2] - r[0][0] - r[1][1]);
    [w, qx, qy, qz] = [(r[1][0] - r[0][1]) / s, (r[0][2] + r[2][0]) / s, (r[1][2] + r[2][1]) / s, 0.25 * s];
  }
  const t = r.map(row => -(row[0] * center[0] + row[1] * center[1] + row[2] * center[2]));
  return `${id} ${w} ${qx} ${qy} ${qz} ${t.join(' ')} 1 ${name}\n0 0 -1\n`;
}

const folder = mkdtempSync(path.join(tmpdir(), 'colmap-test-'));
const close = (a, b, tolerance = 1e-3) => assert.ok(Math.hypot(...sub(a, b)) < tolerance, `${a} vs ${b}`);
try {
  // COLMAP's world is arbitrary; here world "up" is -y, as a COLMAP model often comes out.
  const up = [0, -1, 0], subject = [1, -0.5, 2];
  let lines = '';
  for (let index = 0; index < 36; index++) {
    const angle = index * Math.PI / 18, height = index % 2 ? -1.2 : -1.6; // -y is up, so these are above the subject
    const center = [subject[0] + 2 * Math.cos(angle), height, subject[2] + 2 * Math.sin(angle)];
    lines += imageLine(index + 1, `frame-${String(index + 1).padStart(5, '0')}.jpg`, center, sub(subject, center), up);
  }
  writeFileSync(path.join(folder, 'images.txt'), `# header\n${lines}`);
  writeFileSync(path.join(folder, 'points3D.txt'), '# header\n1 1.5 -0.5 2 200 10 10 0.5 1 0\n2 0.5 -0.4 2.1 10 200 10 0.4 1 1\n');
  assert.deepEqual(Array.from(readColmapPoints(folder)).map(value => Number(value.toFixed(2))), [1.5, -0.5, 2, 0.5, -0.4, 2.1]);
  const cameras = readColmapCameras(folder);
  assert.equal(cameras.length, 36);
  close(cameras[0].center, [subject[0] + 2, -1.6, subject[2]]);
  assert.ok(cameras[0].up[1] < -0.8, 'the camera is held upright');

  const rotation = cameraLevelRotation(cameras);
  const turned = Array.from(rotatePositions(Float32Array.from(up), rotation));
  close(turned, [0, 1, 0]);
  close(cameraUp(cameras), up, 1e-2);

  const orbit = cameraStartView(cameras, rotation);
  assert.equal(orbit.kind, 'orbit');
  const target = Array.from(rotatePositions(Float32Array.from(subject), rotation));
  close([orbit.camera.target.x, orbit.camera.target.y, orbit.camera.target.z], target);
  // The viewer places an orbit camera at target - direction * distance; that must be the capture position.
  const direction = viewDirection(orbit.camera.rotation);
  const placed = target.map((value, axis) => value - direction[axis] * orbit.camera.distance);
  close(placed, [orbit.camera.position.x, orbit.camera.position.y, orbit.camera.position.z]);
  assert.ok(orbit.camera.rotation.polar < 0, 'the start camera looks down at the subject');

  // A walk down a corridor, looking ahead.
  lines = '';
  for (let index = 0; index < 60; index++) {
    const center = [0.05 * Math.sin(index / 5), -1.5, index * 0.2];
    lines += imageLine(index + 1, `frame-${index + 1}.jpg`, center, [0.1 * Math.sin(index / 7), 0.05, 1], up);
  }
  writeFileSync(path.join(folder, 'images.txt'), lines);
  const walk = readColmapCameras(folder);
  assert.equal(walk[1].name, 'frame-2.jpg', 'numeric name order');
  const walkView = cameraStartView(walk, cameraLevelRotation(walk));
  // The phone points 20 degrees down the whole walk; up still comes out true, not tilted with the phone.
  lines = '';
  for (let index = 0; index < 60; index++) {
    lines += imageLine(index + 1, `frame-${index + 1}.jpg`, [0, -1.5, index * 0.2], [0, Math.tan(20 * Math.PI / 180), 1], up);
  }
  writeFileSync(path.join(folder, 'images.txt'), lines);
  const tilted = readColmapCameras(folder);
  assert.ok(tilted[0].up[2] > 0.3, 'each camera\'s own up leans forward');
  close(cameraUp(tilted), up, 1e-2);
  assert.equal(walkView.kind, 'walkthrough');
  assert.equal(walkView.camera.distance, undefined, 'a walkthrough opens in first person');
  assert.ok(Math.abs(walkView.camera.rotation.polar) <= 20);
  console.log('colmap cameras: 2 captures ok');
} finally {
  rmSync(folder, { recursive: true, force: true });
}
