// Reads the registered camera poses of a COLMAP model (images.bin or images.txt) and turns them into the
// opening view of a splat trained from it: level from the cameras' up direction, start where a camera stood.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { eulerTurningToUp, rotatePositions, viewRotation } from './common.mjs';

/** Camera centres, look and up directions (world, COLMAP axes) of every registered image, in name order. */
export function readColmapCameras(model) {
  const binary = path.join(model, 'images.bin'), text = path.join(model, 'images.txt');
  const poses = [];
  if (existsSync(binary)) {
    const data = readFileSync(binary);
    let offset = 0;
    const count = Number(data.readBigUInt64LE(offset)); offset += 8;
    for (let image = 0; image < count; image++) {
      offset += 4; // image id
      const q = [0, 1, 2, 3].map(index => data.readDoubleLE(offset + index * 8)); offset += 32;
      const t = [0, 1, 2].map(index => data.readDoubleLE(offset + index * 8)); offset += 24;
      offset += 4; // camera id
      const end = data.indexOf(0, offset);
      const name = data.toString('utf8', offset, end); offset = end + 1;
      const points = Number(data.readBigUInt64LE(offset)); offset += 8 + points * 24;
      poses.push({ name, q, t });
    }
  } else if (existsSync(text)) {
    const lines = readFileSync(text, 'utf8').split('\n').filter(line => line.trim() && !line.startsWith('#'));
    for (let index = 0; index < lines.length; index += 2) {
      const parts = lines[index].trim().split(/\s+/);
      poses.push({ name: parts.slice(9).join(' '), q: parts.slice(1, 5).map(Number), t: parts.slice(5, 8).map(Number) });
    }
  } else {
    throw new Error(`No images.bin or images.txt in ${model}`);
  }
  return poses.map(({ name, q: [w, x, y, z], t }) => {
    // World-to-camera rotation; the camera looks along +z with +y pointing down the image.
    const r = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
      [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
      [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
    const center = [0, 1, 2].map(axis => -(r[0][axis] * t[0] + r[1][axis] * t[1] + r[2][axis] * t[2]));
    return { name, center, forward: r[2].slice(), up: r[1].map(value => -value) };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Up to `limit` of the model's sparse 3D points (points3D.bin or .txt) as flat xyz, or null without them. */
export function readColmapPoints(model, limit = 200000) {
  const binary = path.join(model, 'points3D.bin'), text = path.join(model, 'points3D.txt');
  const points = [];
  if (existsSync(binary)) {
    const data = readFileSync(binary);
    const count = Number(data.readBigUInt64LE(0));
    const step = Math.max(1, Math.floor(count / limit));
    let offset = 8;
    for (let index = 0; index < count; index++) {
      if (index % step === 0) points.push(data.readDoubleLE(offset + 8), data.readDoubleLE(offset + 16), data.readDoubleLE(offset + 24));
      const track = Number(data.readBigUInt64LE(offset + 43));
      offset += 51 + track * 8;
    }
  } else if (existsSync(text)) {
    for (const line of readFileSync(text, 'utf8').split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const parts = line.trim().split(/\s+/);
      points.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    }
  } else {
    return null;
  }
  return Float32Array.from(points);
}

const add = (a, b) => a.map((value, axis) => value + b[axis]);
const sub = (a, b) => a.map((value, axis) => value - b[axis]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, factor) => a.map(value => value * factor);
const unit = a => scale(a, 1 / (Math.hypot(...a) || 1));
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Eigenvector of the smallest eigenvalue of a symmetric 3x3 matrix (Jacobi rotations). */
function smallestEigenvector(matrix) {
  const a = matrix.map(row => row.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-12) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const [akp, akq] = [a[k][p], a[k][q]];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const [apk, aqk] = [a[p][k], a[q][k]];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const [vkp, vkq] = [v[k][p], v[k][q]];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const smallest = [0, 1, 2].reduce((best, index) => (a[index][index] < a[best][best] ? index : best), 0);
  return [v[0][smallest], v[1][smallest], v[2][smallest]];
}

/**
 * The capture's up direction. People hold phones and cameras without roll, so every camera's right vector
 * is horizontal, and they walk on level ground, so the cameras travel horizontally: up is the direction
 * most perpendicular to both. The average of the cameras' own up vectors breaks ties and picks the sign;
 * when the two disagree by more than 30 degrees (a capture that rises up a facade), the average wins.
 */
export function cameraUp(cameras) {
  const average = unit(cameras.reduce((sum, camera) => add(sum, camera.up), [0, 0, 0]));
  const centroid = scale(cameras.reduce((sum, camera) => add(sum, camera.center), [0, 0, 0]), 1 / cameras.length);
  const rights = cameras.map(camera => [
    camera.up[1] * camera.forward[2] - camera.up[2] * camera.forward[1],
    camera.up[2] * camera.forward[0] - camera.up[0] * camera.forward[2],
    camera.up[0] * camera.forward[1] - camera.up[1] * camera.forward[0]]);
  const offsets = cameras.map(camera => sub(camera.center, centroid));
  const travel = offsets.reduce((sum, offset) => sum + dot(offset, offset), 0) || 1;
  const matrix = [0, 1, 2].map(row => [0, 1, 2].map(column => {
    const turning = rights.reduce((sum, right) => sum + right[row] * right[column], 0) / cameras.length;
    const moving = offsets.reduce((sum, offset) => sum + offset[row] * offset[column], 0) / travel;
    const tie = 0.005 * ((row === column ? 1 : 0) - average[row] * average[column]);
    return turning + 0.5 * moving + tie;
  }));
  let up = unit(smallestEigenvector(matrix));
  if (dot(up, average) < 0) up = scale(up, -1);
  return dot(up, average) > Math.cos(30 * Math.PI / 180) ? up : average;
}

/** Rotation (Euler XYZ, radians) that turns the capture's up direction to +Y. */
export function cameraLevelRotation(cameras) {
  return eulerTurningToUp(cameraUp(cameras));
}

/** Point nearest to every camera's line of sight (least squares), or null when the lines barely constrain it. */
function convergence(cameras) {
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const { center, forward } of cameras) {
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        const term = (row === column ? 1 : 0) - forward[row] * forward[column];
        a[row][column] += term;
        b[row] += term * center[column];
      }
    }
  }
  const det = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
    + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  if (Math.abs(det) < 1e-9 * cameras.length ** 3) return null;
  const solve = column => {
    const m = a.map((row, index) => row.map((value, j) => (j === column ? b[index] : value)));
    return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
      + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])) / det;
  };
  return [solve(0), solve(1), solve(2)];
}

/**
 * The opening view from the capture's own cameras, after `rotation` (the splat's rotation) is applied.
 * Cameras that circle a subject (an orbit) give an orbit view of the point they all look at, from a
 * capture position at a pleasant height. Cameras that travel through a space (a walkthrough) give a
 * first-person view from the start of the walk. Returns { camera, kind } in the viewer's terms.
 */
export function cameraStartView(cameras, rotation) {
  const turn = vector => Array.from(rotatePositions(Float32Array.from(vector), rotation));
  const posed = cameras.map(camera => ({ ...camera, center: turn(camera.center), forward: unit(turn(camera.forward)) }));
  const centroid = scale(posed.reduce((sum, camera) => add(sum, camera.center), [0, 0, 0]), 1 / posed.length);
  const spread = median(posed.map(camera => Math.hypot(...sub(camera.center, centroid)))) || 1;
  const focus = convergence(posed);
  if (focus) {
    const facing = posed.filter(camera => {
      const toward = sub(focus, camera.center), distance = Math.hypot(...toward);
      return distance > 0 && dot(camera.forward, toward) / distance > Math.cos(25 * Math.PI / 180);
    });
    const distances = posed.map(camera => Math.hypot(...sub(focus, camera.center)));
    // An orbit: most cameras look at the point, it lies among them rather than far ahead, and they surround it.
    if (facing.length >= 0.7 * posed.length && median(distances) < 4 * spread) {
      const elevationOf = camera => {
        const away = unit(sub(camera.center, focus));
        return Math.asin(Math.max(-1, Math.min(1, away[1]))) * 180 / Math.PI;
      };
      const start = facing.reduce((best, camera) => (Math.abs(elevationOf(camera) - 25) < Math.abs(elevationOf(best) - 25) ? camera : best));
      const distance = Math.hypot(...sub(focus, start.center));
      const target = { x: focus[0], y: focus[1], z: focus[2] };
      return { kind: 'orbit', camera: { position: { x: start.center[0], y: start.center[1], z: start.center[2] },
        rotation: viewRotation(sub(focus, start.center)), target, distance, from: start.name } };
    }
  }
  // A walkthrough: stand where the walk begins, a few frames in to skip a shaky start, looking level-ish.
  const start = posed[Math.min(posed.length - 1, Math.floor(posed.length * 0.05))];
  const rotationView = viewRotation(start.forward);
  rotationView.polar = Math.max(-20, Math.min(10, rotationView.polar));
  const position = { x: start.center[0], y: start.center[1], z: start.center[2] };
  return { kind: 'walkthrough', camera: { position, rotation: rotationView, target: position, from: start.name } };
}
