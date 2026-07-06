import * as THREE from "three";
import type { AnnotationConfig } from "@/lib/types";
import { TextureCache } from "@/lib/three/TextureCache";

type ManagedAnnotation = {
  config: AnnotationConfig;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
};

export class AnnotationLayer {
  private readonly group = new THREE.Group();
  private readonly annotations = new Map<string, ManagedAnnotation>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly textureCache: TextureCache,
    private readonly configs: AnnotationConfig[]
  ) {
    this.group.name = "annotations";
  }

  init() {
    if (!this.configs.length) return;
    this.configs.forEach((config) => {
      const [width, height] = config.size ?? [1, 1];
      const texture = this.textureCache.load(config.file);
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthTest: false
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
      mesh.name = `annotation-${config.id}`;
      if (config.position) mesh.position.set(...config.position);
      if (config.rotation) mesh.rotation.set(...config.rotation);
      if (typeof config.scale === "number") mesh.scale.setScalar(config.scale);
      if (Array.isArray(config.scale)) mesh.scale.set(...config.scale);
      mesh.renderOrder = 20;
      this.group.add(mesh);
      this.annotations.set(config.id, { config, mesh, material });
    });
    this.scene.add(this.group);
  }

  show(ids: string[] = []) {
    const allowed = new Set(ids);
    this.annotations.forEach((annotation, id) => {
      this.fade(annotation, allowed.has(id) ? annotation.config.opacity ?? 0.65 : 0);
    });
  }

  hideAll() {
    this.annotations.forEach((annotation) => this.fade(annotation, 0));
  }

  dispose() {
    this.scene.remove(this.group);
    this.annotations.forEach(({ mesh, material }) => {
      mesh.geometry.dispose();
      material.dispose();
    });
    this.annotations.clear();
    this.group.clear();
  }

  private fade(annotation: ManagedAnnotation, target: number) {
    const start = annotation.material.opacity;
    const startedAt = performance.now();
    const duration = 450;
    const tick = () => {
      const value = Math.min(1, (performance.now() - startedAt) / duration);
      annotation.material.opacity = start + (target - start) * value;
      annotation.material.needsUpdate = true;
      if (value < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
