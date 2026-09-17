import * as THREE from 'three';
import type { AnnotationConfig } from '@/lib/types';
import { AnnotationLayer } from '@/lib/three/layers/AnnotationLayer';
import { TextureCache } from '@/lib/three/TextureCache';

export type EmbeddedCameraPose = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number };
  projection: ArrayLike<number>;
};

/** World-space annotations synchronized to the embedded viewer's published camera. */
export class EmbeddedAnnotations {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera();
  private readonly textures = new TextureCache();
  private readonly layer: AnnotationLayer;
  private readonly renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  private readonly resize: ResizeObserver;

  constructor(container: HTMLElement, configs: AnnotationConfig[]) {
    const canvas = this.renderer.domElement;
    canvas.className = 'sphr-embedded-annotations';
    canvas.setAttribute('aria-hidden', 'true');
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0, 0);
    container.append(canvas);
    this.resize = new ResizeObserver(() => this.renderer.setSize(container.clientWidth, container.clientHeight));
    this.resize.observe(container);
    this.layer = new AnnotationLayer(this.scene, this.textures, configs);
    this.layer.init();
    this.renderer.setAnimationLoop(() => this.renderer.render(this.scene, this.camera));
  }

  update(pose: EmbeddedCameraPose) {
    this.camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.camera.rotation.set(THREE.MathUtils.degToRad(pose.rotation.x), THREE.MathUtils.degToRad(pose.rotation.y), 0, 'YXZ');
    this.camera.projectionMatrix.fromArray(pose.projection);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  show(ids: string[] = []) { this.layer.show(ids); }
  setMuted(muted: boolean) { this.layer.setMuted(muted); }

  dispose() {
    this.resize.disconnect();
    this.renderer.setAnimationLoop(null);
    this.layer.dispose();
    this.textures.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
