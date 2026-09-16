import test from 'node:test';
import assert from 'node:assert/strict';
import { Ray, Vector3 } from 'three';
import { selectNavigationTarget } from '../lib/three/navigation.ts';

const v = (x, y, z) => new Vector3(x, y, z);
const current = v(0, 0, 0);
const ray = (x, y, z) => new Ray(v(0, 1.6, 0), v(x, y, z).normalize());
const candidate = (value, x, y, z) => ({value, floor:v(x,y,z)});
const forward = candidate('forward', 0, 0, -4);

test('floor clicks between visible markers choose the scan nearest the clicked floor', () => {
  assert.equal(selectNavigationTarget(ray(.2,-1,-1), [forward, candidate('right',4,0,-4)], current, v(3.4,0,-3.8)), 'right');
});
test('clicking at the current scan does not jump to a distant scan', () => {
  assert.equal(selectNavigationTarget(ray(0,-1,0), [forward], current, v(0,0,-.1)), null);
});
test('floor selection does not jump to the storey above', () => {
  assert.equal(selectNavigationTarget(ray(0,-1,-1), [candidate('upstairs',0,3,-4),forward], current,v(0,0,-4)), 'forward');
});
test('downward clicks navigate by bearing even without a mesh hit', () => {
  assert.equal(selectNavigationTarget(ray(0,-1,-1), [forward], current,null), 'forward');
});
test('direction choice is independent of candidate order and prefers the closest bearing', () => {
  const nearSide=candidate('side',1,0,-2);
  for (const nodes of [[nearSide,forward],[forward,nearSide]]) assert.equal(selectNavigationTarget(ray(0,0,-1),nodes,current,null),'forward');
});
test('equal bearings choose the nearer reachable scan', () => {
  assert.equal(selectNavigationTarget(ray(0,0,-1),[forward,candidate('near',0,0,-2)],current,null),'near');
});
test('ceiling, opposite directions, and no reachable scans stay in place', () => {
  assert.equal(selectNavigationTarget(ray(0,1,-.1),[forward],current,null),null);
  assert.equal(selectNavigationTarget(ray(0,0,1),[forward],current,null),null);
  assert.equal(selectNavigationTarget(ray(0,0,-1),[],current,v(0,0,-4)),null);
});
