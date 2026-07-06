import * as THREE from "three";
import type { NodeData } from "@/lib/types";
import { eulerFromLike } from "@/lib/three/math";
import { nodeCubeFaceUrl, nodePanoramaUrl } from "@/lib/media";
import { TextureCache } from "@/lib/three/TextureCache";

type PanoObject = {
  node: NodeData;
  group: THREE.Group;
  materials: THREE.Material[];
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

  constructor(
    private readonly scene: THREE.Scene,
    private readonly textureCache: TextureCache,
    private readonly version?: string | null
  ) {}

  loadInitial(node?: NodeData | null) {
    if (!node) return;
    this.active = this.createPano(node, 1);
    this.scene.add(this.active.group);
  }

  navigate(node: NodeData) {
    if (this.active?.node.uuid === node.uuid) return;
    if (this.outgoing) {
      this.scene.remove(this.outgoing.group);
      this.disposeObject(this.outgoing);
    }

    this.outgoing = this.active;
    this.active = this.createPano(node, 0);
    this.active.group.visible = this.visible;
    this.scene.add(this.active.group);

    const start = performance.now();
    const duration = 700;
    const tick = () => {
      const value = Math.min(1, (performance.now() - start) / duration);
      this.setOpacity(this.active, value);
      this.setOpacity(this.outgoing, 1 - value);
      if (value < 1) {
        requestAnimationFrame(tick);
      } else if (this.outgoing) {
        this.scene.remove(this.outgoing.group);
        this.disposeObject(this.outgoing);
        this.outgoing = null;
      }
    };
    requestAnimationFrame(tick);
  }

  update(camera: THREE.Camera) {
    this.active?.group.position.copy(camera.position);
    this.outgoing?.group.position.copy(camera.position);
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

  dispose() {
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

    if (node.image && !(node.faces?.length || node.cubeFaces?.length || node.textureTemplate)) {
      const texture = this.textureCache.load(nodePanoramaUrl(node, "full"));
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.BackSide,
        transparent: true,
        opacity,
        depthWrite: false,
        depthTest: false
      });
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 40), material);
      sphere.rotation.copy(eulerFromLike(node.rotation));
      group.add(sphere);
      return { node, group, materials: [material] };
    }

    const materials: THREE.Material[] = [];
    for (let face = 0; face < 6; face += 1) {
      const texture = this.textureCache.load(nodeCubeFaceUrl(node, face, "1024", this.version));
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity,
        depthWrite: false,
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
    return { node, group, materials };
  }

  private setOpacity(object: PanoObject | null, opacity: number) {
    object?.materials.forEach((material) => {
      if ("opacity" in material) {
        material.opacity = opacity;
        material.needsUpdate = true;
      }
    });
  }

  private disposeObject(object: PanoObject) {
    object.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
    });
    object.materials.forEach((material) => material.dispose());
  }
}
