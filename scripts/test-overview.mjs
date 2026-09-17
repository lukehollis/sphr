import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Vector3 } from 'three';
import { panoramaOverviewBounds } from '../lib/three/overview.ts';

const v = (x, y, z) => new Vector3(x, y, z);

test('distant fragments do not shrink a narrow surveyed passage to an empty-looking overview', () => {
  const mesh = new Box3(v(-9, -1, -31), v(61, 29, 23));
  const cameras = [v(-2, 1, -1), v(8, 2.5, 1)];
  const floor = v(8, -1, 1);
  const fit = panoramaOverviewBounds(mesh, cameras, [floor]);
  cameras.concat([floor]).forEach((point) => assert.ok(fit.containsPoint(point)));
  assert.ok(fit.getSize(v(0, 0, 0)).length() < mesh.getSize(v(0, 0, 0)).length() / 2);
  assert.equal(mesh.max.x, 61, 'framing does not mutate source geometry bounds');
});

test('normal buildings retain their full mesh framing', () => {
  const mesh = new Box3(v(-5, 0, -5), v(10, 8, 5));
  assert.ok(panoramaOverviewBounds(mesh, [v(0, 1, 0), v(8, 5, 2)]).equals(mesh));
});

test('a single scan or coincident scans cannot infer a reliable surveyed extent', () => {
  const mesh = new Box3(v(-20, -5, -20), v(20, 15, 20));
  for (const points of [[], [v(0, 1, 0)], [v(0, 1, 0), v(0, 1, 0)]]) {
    assert.ok(panoramaOverviewBounds(mesh, points).equals(mesh));
  }
});
