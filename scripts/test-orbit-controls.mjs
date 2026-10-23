import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Unlike a browser's, these targets let a listener's error reach whoever dispatched the event, so a test sees it.
class Target {
  listeners = new Map();
  addEventListener(type, listener) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, event) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, ...event }); }
}
const { PointerSafeOrbitControls } = await import('../lib/three/PointerSafeOrbitControls.ts');

const setup = (Controls) => {
  const page = new Target();
  const canvas = Object.assign(new Target(), {
    style: {}, ownerDocument: page, getRootNode: () => page, clientWidth: 800, clientHeight: 600,
    setPointerCapture() {}, releasePointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 })
  });
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 5);
  const controls = new Controls(camera, canvas);
  const at = (pointerId, pointerType, x = 400, y = 300) => ({ pointerId, pointerType, button: 0, clientX: x, clientY: y, pageX: x, pageY: y, preventDefault() {} });
  return {
    controls, canvas,
    down: (...pointer) => canvas.dispatch('pointerdown', at(...pointer)),
    // OrbitControls hears pointerup on the whole document while a pointer is down.
    up: (...pointer) => canvas.ownerDocument.dispatch('pointerup', at(...pointer))
  };
};

// Each leaves one pointer down without a position, as visitors on the Great Pyramid tour did.
const cases = {
  'a pointerup from a pointer the controls never saw': ({ down, up }) => { down(1, 'mouse'); up(9, 'touch'); },
  'a pen whose pointerup went to the framing page':({ down, up }) => { down(5, 'pen'); down(6, 'pen'); up(6, 'pen'); },
  'a touch lifted while the mouse is held': ({ down, up }) => { down(1, 'mouse'); down(2, 'touch', 500, 300); up(2, 'touch'); }
};

for (const [name, steps] of Object.entries(cases)) {
  test(`${name} no longer throws`, () => {
    assert.throws(() => steps(setup(OrbitControls)), /reading 'x'/, 'three.js still throws here; the fix may be redundant');
    assert.doesNotThrow(() => steps(setup(PointerSafeOrbitControls)));
  });
}

test('lifting every pointer still ends the gesture', () => {
  const { controls, canvas, down, up } = setup(PointerSafeOrbitControls);
  let ended = 0;
  controls.addEventListener('end', () => ended++);
  down(1, 'mouse'); down(2, 'touch', 500, 300); up(9, 'touch'); up(2, 'touch'); up(1, 'mouse');
  assert.equal(ended, 1);
  assert.equal(controls.state, -1);
  assert.equal(canvas.ownerDocument.listeners.get('pointerup').size, 0);
});

test('one finger still rotates the view', () => {
  const { controls, canvas, down, up } = setup(PointerSafeOrbitControls);
  const before = controls.getAzimuthalAngle();
  down(3, 'touch', 400, 300);
  canvas.ownerDocument.dispatch('pointermove', { pointerId: 3, pointerType: 'touch', pageX: 200, pageY: 300, clientX: 200, clientY: 300 });
  controls.update();
  up(3, 'touch');
  assert.notEqual(controls.getAzimuthalAngle(), before);
});
