import test from 'node:test';
import assert from 'node:assert/strict';
import { Ray, Vector3 } from 'three';
import { selectDirectionalTarget, selectNavigationTarget, selectSpotTarget } from '../lib/three/navigation.ts';

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
test('arrow keys walk to the scan ahead or behind and stay put when nothing lies that way', () => {
  const ahead = (x, z) => selectDirectionalTarget(v(x, 0, z), [forward, candidate('back', 0, 0, 3), candidate('right', 5, 0, 0)], current);
  assert.equal(ahead(0, -1), 'forward');
  assert.equal(ahead(0, 1), 'back');
  assert.equal(ahead(1, 0), 'right');
  assert.equal(ahead(-1, 0), null);
});
test('arrow keys prefer a near scan slightly off the heading over a far one dead ahead', () => {
  assert.equal(selectDirectionalTarget(v(0, 0, -1), [candidate('far', 0, 0, -30), candidate('near', 1, 0, -3)], current), 'near');
  assert.equal(selectDirectionalTarget(v(0, 0, -1), [candidate('far', 0, 0, -6), candidate('wide', 3, 0, -3)], current), 'far');
});
test('a click on a distant spot goes straight to the scan nearest it when that scan can be seen', () => {
  const scans = [forward, candidate('far', 1, 0, -20), candidate('farther', 0, 0, -24)];
  const all = () => true;
  assert.equal(selectSpotTarget(v(.5, 0, -19), true, scans, current, all), 'far');
  assert.equal(selectSpotTarget(v(.5, 0, -19), true, scans, current, value => value !== 'far'), 'farther', 'a hidden scan gives way to the next nearest');
  assert.equal(selectSpotTarget(v(0, 0, -.2), true, scans, current, all), null, 'a click at your feet stays put');
  assert.equal(selectSpotTarget(v(1, 3.2, -20), true, [...scans, candidate('upstairs', 1, 3, -20)], current, all), 'upstairs');
  assert.equal(selectSpotTarget(v(1, 6, -21), false, scans, current, all), 'far', 'a wall click goes to the scan at its foot');
  const many = Array.from({ length: 10 }, (_, i) => candidate(`s${i}`, 0, 0, -10 - i));
  assert.equal(selectSpotTarget(v(0, 0, -10), true, many, current, value => value === 's9'), null, 'only the nearest few are tested');
});
