import type * as THREE from "three";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

let shared: KTX2Loader | null = null;

/**
 * One KTX2 transcoder for the page. Phones' light copies of capture and reconstruction models keep
 * their textures GPU-compressed (KTX2, Basis), several times smaller in graphics memory than JPEG or
 * WebP once drawn. The transcoder (public/basis, from three's examples) loads only when one appears.
 */
export function ktx2Loader(renderer: THREE.WebGLRenderer) {
  shared ??= new KTX2Loader().setTranscoderPath("/basis/").setWorkerLimit(2).detectSupport(renderer);
  return shared;
}
