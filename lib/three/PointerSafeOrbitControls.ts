import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** OrbitControls' own pointer bookkeeping, which three's types leave out. */
type Pointers = {
  _pointers: number[];
  _pointerPositions: Record<number, THREE.Vector2>;
  _onPointerDown: (event: PointerEvent) => void;
  _onPointerUp: (event: PointerEvent) => void;
};

/**
 * OrbitControls keeps a position only for touches, yet when one of two pointers lifts it reads the other's, and while
 * any pointer is down it hears every pointerup on the page. A mouse or pen held with another pointer, or one whose own
 * pointerup went elsewhere (to the page framing the tour), had no position to read: every later click threw "Cannot
 * read properties of undefined (reading 'x')". Here every pointer it holds has a position, and it hears only those.
 */
export class PointerSafeOrbitControls extends OrbitControls {
  constructor(camera: THREE.Camera, element: HTMLElement) {
    // Connected only once its handlers are wrapped, so the listeners are these.
    super(camera);
    const own = this as unknown as Pointers;
    const down = own._onPointerDown, up = own._onPointerUp;
    own._onPointerDown = (event) => {
      down(event);
      if (own._pointers.includes(event.pointerId)) (own._pointerPositions[event.pointerId] ??= new THREE.Vector2()).set(event.pageX, event.pageY);
    };
    own._onPointerUp = (event) => { if (own._pointers.includes(event.pointerId)) up(event); };
    this.connect(element);
  }
}
