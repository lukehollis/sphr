import * as THREE from "three";
import type { AnnotationConfig } from "@/lib/types";
import { TextureCache } from "@/lib/three/TextureCache";

type ManagedAnnotation = {
  config: AnnotationConfig;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  video?: HTMLVideoElement;
  active: boolean;
  fadeVersion: number;
};

export class AnnotationLayer {
  private readonly group = new THREE.Group();
  private readonly annotations = new Map<string, ManagedAnnotation>();
  private disposed = false;
  private muted = false;
  private retryVideos = () => {
    this.annotations.forEach(annotation => {
      if (annotation.active && annotation.video) this.playVideo(annotation);
    });
  };

  private playVideo(annotation: ManagedAnnotation) {
    const video = annotation.video!;
    video.muted = this.muted;
    void video.play().catch(() => {
      // Keep the animation running when autoplay blocks its soundtrack.
      // Normal interaction retries the requested audio state.
      if (this.disposed || !annotation.active) return;
      video.muted = true;
      void video.play().catch(() => {});
    });
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.annotations.forEach(annotation => {
      if (annotation.video) annotation.video.muted = muted;
    });
    this.retryVideos();
  }

  constructor(
    private readonly scene: THREE.Scene,
    private readonly textureCache: TextureCache,
    private readonly configs: AnnotationConfig[]
  ) {
    this.group.name = "annotations";
  }

  init() {
    if (!this.configs.length) return;
    window.addEventListener('pointerup', this.retryVideos, true);
    window.addEventListener('keydown', this.retryVideos, true);
    this.configs.forEach((config) => {
      const [width, height] = config.size ?? [1, 1];
      let video: HTMLVideoElement | undefined;
      let texture: THREE.Texture | null;
      if (/\.(mp4|webm|ogv)(?:[?#]|$)/i.test(config.file)) {
        video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.loop = true;
        video.muted = this.muted;
        video.volume = config.volume ?? 0.5;
        video.playsInline = true;
        video.preload = 'metadata';
        video.src = config.file;
        video.hidden = true;
        video.dataset.sphrAnnotation = config.id;
        document.body.append(video);
        texture = new THREE.VideoTexture(video);
        texture.colorSpace = THREE.SRGBColorSpace;
      } else texture = this.textureCache.load(config.file);
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
      this.annotations.set(config.id, { config, mesh, material, video, active: false, fadeVersion: 0 });
    });
    this.scene.add(this.group);
  }

  show(ids: string[] = []) {
    const allowed = new Set(ids);
    this.annotations.forEach((annotation, id) => {
      annotation.active = allowed.has(id);
      if (annotation.active && annotation.video) this.playVideo(annotation);
      this.fade(annotation, annotation.active ? annotation.config.opacity ?? 0.65 : 0);
    });
  }

  hideAll() {
    this.show([]);
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('pointerup', this.retryVideos, true);
    window.removeEventListener('keydown', this.retryVideos, true);
    this.scene.remove(this.group);
    this.annotations.forEach(({ mesh, material, video }) => {
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
        material.map?.dispose();
      }
      mesh.geometry.dispose();
      material.dispose();
    });
    this.annotations.clear();
    this.group.clear();
  }

  private fade(annotation: ManagedAnnotation, target: number) {
    const version = ++annotation.fadeVersion;
    const start = annotation.material.opacity;
    const startedAt = performance.now();
    const duration = 450;
    const tick = () => {
      if (this.disposed || version !== annotation.fadeVersion) return;
      const value = Math.min(1, (performance.now() - startedAt) / duration);
      annotation.material.opacity = start + (target - start) * value;
      annotation.material.needsUpdate = true;
      if (value < 1) requestAnimationFrame(tick);
      else if (!annotation.active) annotation.video?.pause();
    };
    requestAnimationFrame(tick);
  }
}
