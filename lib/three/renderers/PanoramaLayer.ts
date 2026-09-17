import * as THREE from "three";
import type { NodeData } from "@/lib/types";
import { eulerFromLike } from "@/lib/three/math";
import { nodeCubeFaceUrl, nodePanoramaUrl } from "@/lib/media";
import { TextureCache } from "@/lib/three/TextureCache";

type PanoObject = {
  node: NodeData;
  group: THREE.Group;
  materials: THREE.Material[];
  urls: string[];
};

const FACE_ROTATIONS: [number, number, number][] = [
  [Math.PI / 2, 0, Math.PI],
  [0, Math.PI, 0],
  [0, Math.PI / 2, 0],
  [0, 0, 0],
  [0, -Math.PI / 2, 0],
  [-Math.PI / 2, 0, Math.PI]
];

const FACE_POSITIONS: [number, number, number][] = [
  [0, 100, 0],
  [0, 0, 100],
  [-100, 0, 0],
  [0, 0, -100],
  [100, 0, 0],
  [0, -100, 0]
];

function applyProductionCubeRotation(group: THREE.Group, node: NodeData) {
  if (node.quaternion) { group.quaternion.fromArray(node.quaternion); return; }
  const rotation = eulerFromLike(node.rotation);
  const nodeQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation.x, -rotation.y, rotation.z));
  const cubeBasisQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI, "XYZ"));
  group.quaternion.copy(nodeQuaternion.multiply(cubeBasisQuaternion));
}

export class PanoramaLayer {
  private active: PanoObject | null = null;
  private outgoing: PanoObject | null = null;
  private transitionCapture: PanoObject | null = null;
  private transitionScene: THREE.Scene | null = null;
  private visible = true;
  private presentationOpacity = 1;
  private disposed = false;
  private fade: { start: number; duration: number; fadeStart: number } | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly textureCache: TextureCache,
    private readonly version?: string | null
  ) {}

  private urls(node: NodeData) {
    return node.image && !(node.faces?.length || node.cubeFaces?.length || node.textureTemplate)
      ? [nodePanoramaUrl(node, "full")]
      : Array.from({ length: 6 }, (_, face) => nodeCubeFaceUrl(node, face, "1024", this.version));
  }

  async prepare(node: NodeData) {
    const urls = this.urls(node);
    this.textureCache.retain(urls);
    try { await Promise.all(urls.map((url) => this.textureCache.loadAsync(url))); }
    finally { this.textureCache.release(urls, false); }
  }

  async loadInitial(node?: NodeData | null) {
    if (!node) return;
    await this.prepare(node);
    if (this.disposed) return;
    this.active = this.createPano(node, 1);
    this.scene.add(this.active.group);
  }

  navigate(node: NodeData, duration = 700, options: { replaceImmediately?: boolean; fadeStart?: number } = {}) {
    if (this.disposed || this.active?.node.uuid === node.uuid) return;
    if (this.outgoing) { this.scene.remove(this.outgoing.group); this.disposeObject(this.outgoing); }
    this.outgoing = this.active;
    if (this.outgoing) {
      this.setOpacity(this.outgoing, 1);
      this.outgoing.group.traverse((mesh) => { mesh.renderOrder = -20; });
    }
    if (options.replaceImmediately && this.outgoing) {
      this.scene.remove(this.outgoing.group);
      this.disposeObject(this.outgoing);
      this.outgoing = null;
    }
    this.active = this.createPano(node, options.replaceImmediately ? 1 : 0);
    this.active.group.visible = this.visible;
    this.scene.add(this.active.group);
    this.fade = options.replaceImmediately ? null : {
      start: performance.now(), duration: Math.max(1, duration),
      fadeStart: THREE.MathUtils.clamp(options.fadeStart ?? 0, 0, 0.99)
    };
  }

  update(camera: THREE.Camera) {
    this.active?.group.position.copy(camera.position);
    this.outgoing?.group.position.copy(camera.position);
    if (!this.fade) return;
    const progress = this.fadeProgress();
    this.setOpacity(this.active, progress);
    if (progress === 1) {
      if (this.outgoing) { this.scene.remove(this.outgoing.group); this.disposeObject(this.outgoing); this.outgoing = null; }
      this.fade = null;
    }
  }

  getDebugSnapshot() {
    return {
      activeNode: this.active?.node.uuid, outgoingNode: this.outgoing?.node.uuid,
      fading: Boolean(this.fade), visible: this.visible, incomingOpacity: this.fadeProgress() * this.presentationOpacity
    };
  }

  private fadeProgress() {
    if (!this.fade) return 1;
    const elapsed = (performance.now() - this.fade.start) / this.fade.duration;
    return THREE.MathUtils.clamp((elapsed - this.fade.fadeStart) / (1 - this.fade.fadeStart), 0, 1);
  }

  prepareTransitionCapture(scene: THREE.Scene, node: NodeData, position: THREE.Vector3) {
    this.clearTransitionCapture();
    this.transitionScene = scene;
    this.transitionCapture = this.createPano(node, 1);
    this.transitionCapture.group.name = `panorama-transition-capture-${node.uuid}`;
    this.transitionCapture.group.position.copy(position);
    scene.add(this.transitionCapture.group);
  }

  updateTransitionCapture(position: THREE.Vector3) {
    this.transitionCapture?.group.position.copy(position);
  }

  clearTransitionCapture() {
    if (!this.transitionCapture) return;
    this.transitionScene?.remove(this.transitionCapture.group);
    this.disposeObject(this.transitionCapture);
    this.transitionCapture = null;
    this.transitionScene = null;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (this.active) this.active.group.visible = visible;
    if (this.outgoing) this.outgoing.group.visible = visible;
  }

  setPresentationOpacity(opacity: number) {
    this.presentationOpacity = THREE.MathUtils.clamp(opacity, 0, 1);
    const progress = this.fadeProgress();
    this.setOpacity(this.active, progress);
    this.setOpacity(this.outgoing, 1);
  }

  dispose() {
    this.disposed = true;
    this.fade = null;
    this.clearTransitionCapture();
    [this.active, this.outgoing].forEach((object) => {
      if (!object) return;
      this.scene.remove(object.group);
      this.disposeObject(object);
    });
    this.active = null;
    this.outgoing = null;
  }

  private createPano(node: NodeData, opacity: number): PanoObject {
    const group = new THREE.Group();
    group.name = `panorama-${node.uuid}`;
    const urls = this.urls(node);
    this.textureCache.retain(urls);

    if (node.image && !(node.faces?.length || node.cubeFaces?.length || node.textureTemplate)) {
      const texture = this.textureCache.getReady(urls[0]);
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.BackSide,
        transparent: true,
        opacity,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        depthTest: false
      });
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 40), material);
      sphere.renderOrder = -10;
      sphere.rotation.copy(eulerFromLike(node.rotation));
      group.add(sphere);
      return { node, group, materials: [material], urls };
    }

    const materials: THREE.Material[] = [];
    for (let face = 0; face < 6; face += 1) {
      const texture = this.textureCache.getReady(urls[face]);
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        depthTest: false
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), material);
      mesh.rotation.set(...FACE_ROTATIONS[face]);
      mesh.position.set(...FACE_POSITIONS[face]);
      mesh.renderOrder = -10;
      group.add(mesh);
      materials.push(material);
    }
    applyProductionCubeRotation(group, node);
    return { node, group, materials, urls };
  }

  private setOpacity(object: PanoObject | null, opacity: number) {
    object?.materials.forEach((material) => {
      if ("opacity" in material) {
        material.opacity = opacity * this.presentationOpacity;

      }
    });
  }

  private disposeObject(object: PanoObject) {
    this.textureCache.release(object.urls);
    object.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
    });
    object.materials.forEach((material) => material.dispose());
  }
}
