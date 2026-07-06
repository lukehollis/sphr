import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { SceneGraphNode } from "@/lib/types";
import { applyTransform } from "@/lib/three/math";

type SceneGraphRecord = {
  node: SceneGraphNode;
  object: THREE.Object3D;
  meshes: THREE.Mesh[];
  materials: THREE.Material[];
  originalMaterialsByMesh: WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>;
  originalOpacity: WeakMap<THREE.Material, number>;
  originalTransparent: WeakMap<THREE.Material, boolean>;
  transitionMaterial: THREE.MeshBasicMaterial | null;
  transitionOpacity: number;
};

export type NavigationTransitionMaterialOptions = {
  meshIds?: string[];
  opacity?: number;
  fadeMs?: number;
};

export type NavigationTransitionMaterialState = {
  ids: string[];
  initialOpacity: number;
  fadeMs: number;
};

export class SceneGraphLayer {
  private readonly root = new THREE.Group();
  private readonly lookup = new Map<string, THREE.Object3D>();
  private readonly records = new Map<string, SceneGraphRecord>();
  private readonly raycastObjects: THREE.Object3D[] = [];
  private readonly loader: GLTFLoader;
  private activeIds = new Set<string>();
  private transitionActiveIds = new Set<string>();
  private viewMode: "FPV" | "ORBIT" = "FPV";
  private debug = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly nodes: SceneGraphNode[]
  ) {
    this.root.name = "scene-graph";
    this.loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
    this.loader.setDRACOLoader(draco);
  }

  async init() {
    this.scene.add(this.root);
    await Promise.all(this.nodes.map((node) => this.buildNode(node, this.root)));
    this.applyVisibility();
  }

  showOnly(ids: string[] = []) {
    this.activeIds = new Set(ids);
    this.applyVisibility();
  }

  hideAll() {
    this.activeIds.clear();
    this.applyVisibility();
  }

  setViewMode(viewMode: "FPV" | "ORBIT", debug = false) {
    this.viewMode = viewMode;
    this.debug = debug;
    this.applyVisibility();
  }

  getObject(id: string) {
    return this.lookup.get(id) ?? null;
  }

  getRaycastObjects() {
    return this.raycastObjects;
  }

  hasNavigationTransitionMeshes() {
    return Array.from(this.records.values()).some((record) => this.isTransitionRecord(record));
  }

  showNavigationTransition(
    envMap: THREE.Texture | null,
    options: NavigationTransitionMaterialOptions = {}
  ): NavigationTransitionMaterialState | null {
    if (!envMap) return null;

    const records = this.getTransitionRecords(options.meshIds);
    if (!records.length) return null;

    this.restoreNavigationTransition();

    const opacities: number[] = [];
    const fadeDurations: number[] = [];
    for (const record of records) {
      const opacity = record.node.transitionOpacity ?? options.opacity ?? 0.2;
      const fadeMs = record.node.transitionFadeMs ?? options.fadeMs ?? 400;
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        envMap,
        transparent: true,
        opacity,
        side: THREE.FrontSide,
        depthWrite: false,
        depthTest: true
      });
      material.needsUpdate = true;

      record.transitionMaterial = material;
      record.transitionOpacity = opacity;
      record.object.visible = true;
      record.meshes.forEach((mesh) => {
        mesh.visible = true;
        mesh.material = material;
        mesh.renderOrder = 10;
      });
      this.transitionActiveIds.add(record.node.id);
      opacities.push(opacity);
      fadeDurations.push(fadeMs);
    }

    return {
      ids: records.map((record) => record.node.id),
      initialOpacity: Math.max(...opacities),
      fadeMs: Math.max(...fadeDurations)
    };
  }

  setNavigationTransitionOpacity(opacity: number) {
    this.transitionActiveIds.forEach((id) => {
      const record = this.records.get(id);
      if (!record?.transitionMaterial) return;
      record.transitionMaterial.opacity = Math.max(0, opacity);
      record.transitionMaterial.needsUpdate = true;
      record.transitionOpacity = Math.max(0, opacity);
    });
  }

  restoreNavigationTransition() {
    if (!this.transitionActiveIds.size) return;

    const ids = Array.from(this.transitionActiveIds);
    this.transitionActiveIds.clear();
    ids.forEach((id) => {
      const record = this.records.get(id);
      if (!record) return;
      record.meshes.forEach((mesh) => {
        const original = record.originalMaterialsByMesh.get(mesh);
        if (original) mesh.material = original;
        mesh.renderOrder = 0;
      });
      record.transitionMaterial?.dispose();
      record.transitionMaterial = null;
      record.transitionOpacity = 0;
      const active = Boolean(record.node.persistent) || this.activeIds.has(id);
      this.applyMaterialState(record, active);
    });
  }

  getDebugSnapshot() {
    return {
      transition: {
        activeIds: Array.from(this.transitionActiveIds),
        opacity: Math.max(
          0,
          ...Array.from(this.transitionActiveIds).map((id) => this.records.get(id)?.transitionOpacity ?? 0)
        )
      },
      records: Array.from(this.records.values()).map((record) => ({
        id: record.node.id,
        visible: record.object.visible,
        transitionMesh: this.isTransitionRecord(record),
        meshCount: record.meshes.length,
        firstOpacity: this.materialOpacity(record.materials[0])
      }))
    };
  }

  dispose() {
    this.restoreNavigationTransition();
    this.scene.remove(this.root);
    this.root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((material) => material.dispose());
      } else {
        mesh.material?.dispose?.();
      }
    });
    this.root.clear();
    this.lookup.clear();
    this.records.clear();
    this.raycastObjects.length = 0;
  }

  private async buildNode(node: SceneGraphNode, parent: THREE.Object3D) {
    if (node.type === "group") {
      const group = new THREE.Group();
      group.name = node.id;
      applyTransform(group, node);
      parent.add(group);
      this.lookup.set(node.id, group);
      await Promise.all((node.children ?? []).map((child) => this.buildNode(child, group)));
      return;
    }

    if (node.type === "pointLight") {
      const light = new THREE.PointLight(node.color ?? 0xffffff, node.intensity ?? 1, node.distance ?? 1000);
      light.name = node.id;
      applyTransform(light, node);
      parent.add(light);
      this.lookup.set(node.id, light);
      return;
    }

    if (node.type === "ambientLight") {
      const light = new THREE.AmbientLight(node.color ?? 0xffffff, node.intensity ?? 1);
      light.name = node.id;
      parent.add(light);
      this.lookup.set(node.id, light);
      return;
    }

    if (node.type === "directionalLight") {
      const light = new THREE.DirectionalLight(node.color ?? 0xffffff, node.intensity ?? 1);
      light.name = node.id;
      applyTransform(light, node);
      parent.add(light);
      this.lookup.set(node.id, light);
      return;
    }

    if (node.type === "model" && node.file) {
      const gltf = await this.loader.loadAsync(node.file);
      gltf.scene.name = node.id;
      applyTransform(gltf.scene, node);
      parent.add(gltf.scene);
      this.lookup.set(node.id, gltf.scene);
      const record = this.createRecord(node, gltf.scene);
      this.records.set(node.id, record);
      if (node.raycast) this.raycastObjects.push(gltf.scene);
    }
  }

  private createRecord(node: SceneGraphNode, object: THREE.Object3D): SceneGraphRecord {
    const meshes: THREE.Mesh[] = [];
    const materials: THREE.Material[] = [];
    const originalMaterialsByMesh = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
    const originalOpacity = new WeakMap<THREE.Material, number>();
    const originalTransparent = new WeakMap<THREE.Material, boolean>();

    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;

      const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const clonedMaterials = sourceMaterials.map((material) => material.clone());
      const clonedMaterial = Array.isArray(mesh.material) ? clonedMaterials : clonedMaterials[0];
      mesh.material = clonedMaterial;
      meshes.push(mesh);
      originalMaterialsByMesh.set(mesh, clonedMaterial);
      clonedMaterials.forEach((material) => {
        const opacity = typeof material.opacity === "number" ? material.opacity : 1;
        materials.push(material);
        originalOpacity.set(material, opacity);
        originalTransparent.set(material, material.transparent);
      });
    });

    return {
      node,
      object,
      meshes,
      materials,
      originalMaterialsByMesh,
      originalOpacity,
      originalTransparent,
      transitionMaterial: null,
      transitionOpacity: 0
    };
  }

  private applyVisibility() {
    this.lookup.forEach((object, id) => {
      const record = this.records.get(id);
      const node = record?.node;
      const active = Boolean(node?.persistent) || this.activeIds.has(id);
      object.visible = active || Boolean(node?.raycast);
      if (record && this.transitionActiveIds.has(id)) {
        record.object.visible = true;
        return;
      }
      if (record) this.applyMaterialState(record, active);
    });
  }

  private applyMaterialState(record: SceneGraphRecord, active: boolean) {
    const node = record.node;
    const opacity =
      this.debug && typeof node.debugOpacity === "number"
        ? node.debugOpacity
        : this.viewMode === "ORBIT"
          ? node.orbitOpacity ?? 1
          : node.fpvOpacity ?? 1;
    const effectiveOpacity = active ? opacity : 0;
    const visibleForRaycast = Boolean(node.raycast);

    record.object.visible = active || visibleForRaycast;
    for (const material of record.materials) {
      const baseOpacity = record.originalOpacity.get(material) ?? 1;
      const originalTransparent = record.originalTransparent.get(material) ?? material.transparent;
      material.opacity = baseOpacity * effectiveOpacity;
      material.transparent = originalTransparent || effectiveOpacity < 1;
      if (node.raycast) material.side = THREE.DoubleSide;
      material.depthWrite = effectiveOpacity >= 1;
      material.depthTest = effectiveOpacity >= 1;
      if ("wireframe" in material) {
        (material as THREE.MeshBasicMaterial).wireframe = Boolean(this.debug && node.wireframeInDebug);
      }
      material.needsUpdate = true;
    }
  }

  private getTransitionRecords(ids?: string[]) {
    const allowedIds = ids?.length ? new Set(ids) : null;
    return Array.from(this.records.values()).filter((record) => {
      if (allowedIds && !allowedIds.has(record.node.id)) return false;
      return this.isTransitionRecord(record);
    });
  }

  private isTransitionRecord(record: SceneGraphRecord) {
    return (
      record.node.transitionMesh === true ||
      typeof record.node.transitionOpacity === "number" ||
      record.node.transitionTexture === "cube-render-target"
    );
  }

  private materialOpacity(material?: THREE.Material) {
    if (!material || !("opacity" in material)) return null;
    return material.opacity;
  }
}
