import * as THREE from "three";
import type { IiifConfig } from "@/lib/types";
import { iiifConfigUrl, iiifInfoUrl } from "@/lib/media";
import { TextureCache } from "@/lib/three/TextureCache";

type IiifInfo = {
  width?: number;
  height?: number;
};

export class IiifImageLayer {
  private readonly group = new THREE.Group();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly textureCache: TextureCache,
    private readonly configs: IiifConfig[]
  ) {
    this.group.name = "iiif-images";
  }

  async init() {
    if (!this.configs.length) return;
    this.scene.add(this.group);
    await Promise.all(this.configs.map((config) => this.addImage(config)));
  }

  setVisible(visible: boolean) {
    this.group.visible = visible;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((material) => material.dispose());
      } else {
        mesh.material?.dispose?.();
      }
    });
    this.group.clear();
  }

  private async addImage(config: IiifConfig) {
    const info = await this.fetchInfo(config);
    const width = config.width ?? info.width ?? 1;
    const height = config.height ?? info.height ?? 1;
    const aspect = width / Math.max(1, height);
    const planeHeight = 4;
    const planeWidth = planeHeight * aspect;

    const texture = this.textureCache.load(iiifConfigUrl(config));
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: true
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(planeWidth, planeHeight), material);
    mesh.name = config.id ?? "iiif-image";
    if (config.position) mesh.position.set(...config.position);
    if (Array.isArray(config.rotation)) {
      const rotation = config.rotation as [number, number, number];
      mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    }
    if (typeof config.scale === "number") mesh.scale.setScalar(config.scale);
    if (Array.isArray(config.scale)) {
      const scale = config.scale as [number, number, number];
      mesh.scale.set(scale[0], scale[1], scale[2]);
    }
    this.group.add(mesh);
  }

  private async fetchInfo(config: IiifConfig): Promise<IiifInfo> {
    const url = iiifInfoUrl(config);
    if (!url) return {};
    try {
      const response = await fetch(url);
      if (!response.ok) return {};
      return (await response.json()) as IiifInfo;
    } catch {
      return {};
    }
  }
}
