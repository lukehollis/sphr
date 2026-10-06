import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
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
  origin?: THREE.Vector3;
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
  private readonly tint = new THREE.Color(1, 1, 1);
  private readonly originalColors = new WeakMap<THREE.Material, THREE.Color>();
  private readonly raycastObjects: THREE.Object3D[] = [];
  private readonly loader: GLTFLoader;
  private activeIds = new Set<string>();
  private transitionActiveIds = new Set<string>();
  private viewMode: "FPV" | "ORBIT" = "FPV";
  private debug = false;
  private overviewReturnBlend: number | null = null;
  private occluding = false;
  /** How much of the capture shows while a reconstruction stands in for it (1 as captured). */
  private captureOpacity = 1;

  private deferred: SceneGraphNode[] = [];
  private deferredLoad: Promise<void> | null = null;
  private disposed = false;

  /**
   * @param lighter published model addresses and lighter copies to load in their place
   * @param ktx2 reads GPU-compressed textures (the lighter copies use them)
   */
  constructor(
    private readonly scene: THREE.Scene,
    private readonly nodes: SceneGraphNode[],
    private readonly lighter: Record<string, string> = {},
    ktx2?: KTX2Loader
  ) {
    this.root.name = "scene-graph";
    this.loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
    this.loader.setDRACOLoader(draco);
    if (ktx2) this.loader.setKTX2Loader(ktx2);
  }

  /** @param later top-level nodes to leave for loadDeferred, after the first view */
  async init(later?: (node: SceneGraphNode) => boolean) {
    this.scene.add(this.root);
    this.deferred = later ? this.nodes.filter(later) : [];
    await Promise.all(this.nodes.filter((node) => !this.deferred.includes(node)).map((node) => this.buildNode(node, this.root)));
    this.applyVisibility();
  }

  /** Every model is in: nothing was left for later, or it has arrived (or failed to). */
  get complete() {
    return !this.deferred.length;
  }

  /** Whether any of these models was left for later and is not in yet. */
  waitsFor(ids: string[]) {
    if (!this.deferred.length || !ids.length) return false;
    const wanted = new Set(ids);
    const holds = (node: SceneGraphNode): boolean => wanted.has(node.id) || (node.children ?? []).some(holds);
    return this.deferred.some(holds);
  }

  /** Loads what init left for later, once. */
  loadDeferred() {
    this.deferredLoad ??= Promise.all(this.deferred.map((node) => this.buildNode(node, this.root)
      .catch((error) => console.warn(`Unable to load ${node.id}`, error)))).then(() => {
      this.deferred = [];
      if (!this.disposed) this.applyVisibility();
    });
    return this.deferredLoad;
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

  setOverviewReturnBlend(blend: number | null) {
    this.overviewReturnBlend = blend;
    this.applyVisibility();
  }

  getObject(id: string) {
    return this.lookup.get(id) ?? null;
  }

  getBounds(ids?: string[]) {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    if (ids) {
      for (const id of ids) {
        const record = this.records.get(id);
        if (record) box.expandByObject(record.object);
      }
    } else {
      for (const object of this.raycastObjects) box.expandByObject(object);
    }
    return box;
  }

  getRaycastObjects() {
    return this.raycastObjects;
  }

  /** Meshes of the captured space (the raycast models), for effects drawn on its surfaces. */
  getSurfaceMeshes() {
    const meshes: THREE.Mesh[] = [];
    for (const record of this.records.values()) if (record.node.raycast) meshes.push(...record.meshes);
    return meshes;
  }

  /**
   * While a tour places objects, the hidden capture mesh writes depth in
   * first-person view so walls in the panorama hide objects behind them.
   */
  setOccluding(occluding: boolean) {
    if (this.occluding === occluding) return;
    this.occluding = occluding;
    this.applyVisibility();
  }

  /**
   * A reconstruction stands in for the capture: scales the opacity of the
   * capture's meshes (the raycast models), which stay raycastable. Hidden
   * entirely, they also stop hiding placed objects in first person, since the
   * reconstruction's own walls do that.
   */
  setCaptureOpacity(opacity: number) {
    const value = THREE.MathUtils.clamp(opacity, 0, 1);
    if (Math.abs(value - this.captureOpacity) < 1e-4) return;
    this.captureOpacity = value;
    this.applyVisibility();
  }

  /** Whether a model is part of the capture (a raycast mesh) rather than something a tour added. */
  isCapture(id: string) {
    return Boolean(this.records.get(id)?.node.raycast);
  }

  /** The reconstruction has taken the capture's place entirely. */
  get captureReplaced() {
    return this.captureOpacity === 0;
  }

  hasNavigationTransitionMeshes() {
    return Array.from(this.records.values()).some((record) => this.isTransitionRecord(record));
  }

  showNavigationTransition(
    envMap: THREE.Texture | null,
    options: NavigationTransitionMaterialOptions = {}
  ): NavigationTransitionMaterialState | null {
    if (!envMap) return null;

    const records = this.getTransitionRecords(options.meshIds).filter((record) => this.captureOpacity > 0 || !this.isReplaced(record));
    if (!records.length) return null;

    this.restoreNavigationTransition();

    const opacities: number[] = [];
    const fadeDurations: number[] = [];
    for (const record of records) {
      const opacity = record.node.transitionOpacity ?? options.opacity ?? 0.2;
      const fadeMs = record.node.transitionFadeMs ?? options.fadeMs ?? 400;
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
        depthWrite: true,
        depthTest: true
      });
      const origin = options.origin?.clone() ?? new THREE.Vector3();
      material.onBeforeCompile = (shader) => {
        shader.uniforms.panoramaMap = { value: envMap };
        shader.uniforms.captureOrigin = { value: origin };
        shader.vertexShader = "varying vec3 vCaptureWorld;\n" + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvCaptureWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
        shader.fragmentShader = "uniform samplerCube panoramaMap;\nuniform vec3 captureOrigin;\nvarying vec3 vCaptureWorld;\n" + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", "diffuseColor *= textureCube(panoramaMap, normalize(vCaptureWorld - captureOrigin));");
      };
      material.customProgramCacheKey = () => "sphr-camera-projection-v1";
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

  /**
   * The light unlit captured models take on under a tour sky (white for their own
   * colors); lit models and placed objects take it from the scene's lights instead.
   */
  setTint(color: THREE.Color) {
    if (this.tint.equals(color)) return;
    this.tint.copy(color);
    for (const record of this.records.values()) {
      for (const material of record.materials) {
        const basic = material as THREE.MeshBasicMaterial;
        if (!basic.isMeshBasicMaterial || !basic.color) continue;
        const original = this.originalColors.get(basic) ?? basic.color.clone();
        this.originalColors.set(basic, original);
        basic.color.copy(original).multiply(this.tint);
      }
    }
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
    this.disposed = true;
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
      const gltf = await this.loader.loadAsync(this.lighter[node.file] ?? node.file);
      if (this.disposed) return;
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
      const clonedMaterials = sourceMaterials.map((material) => node.unlit
        ? new THREE.MeshBasicMaterial({ map: (material as THREE.MeshStandardMaterial).map, color: (material as THREE.MeshStandardMaterial).color ?? 0xffffff, vertexColors: Boolean(mesh.geometry.attributes.color), side: THREE.FrontSide, toneMapped: false, fog: false })
        : material.clone());
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
        record.object.visible = this.captureOpacity > 0 || !this.isReplaced(record);
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
        : this.overviewReturnBlend !== null
          ? THREE.MathUtils.lerp(node.orbitOpacity ?? 1, node.fpvOpacity ?? 1, this.overviewReturnBlend)
        : this.viewMode === "ORBIT"
          ? node.orbitOpacity ?? 1
          : node.fpvOpacity ?? 1;
    const visibleForRaycast = Boolean(node.raycast);
    const capture = this.isReplaced(record) ? this.captureOpacity : 1;
    const effectiveOpacity = (active ? opacity : 0) * capture;
    const occluder = this.occluding && visibleForRaycast && effectiveOpacity === 0 && this.viewMode === "FPV" && !this.debug && this.overviewReturnBlend === null && capture > 0.999;
    // Fully replaced by a reconstruction, the capture is not drawn at all; rays still find it.
    const replaced = this.isReplaced(record) && capture === 0 && !occluder;
    record.meshes.forEach((mesh) => { mesh.renderOrder = occluder ? 30 : 0; mesh.visible = !replaced; });

    record.object.visible = !replaced && (active || visibleForRaycast);
    for (const material of record.materials) {
      const baseOpacity = record.originalOpacity.get(material) ?? 1;
      const originalTransparent = record.originalTransparent.get(material) ?? material.transparent;
      material.opacity = baseOpacity * effectiveOpacity;
      material.transparent = originalTransparent || effectiveOpacity < 1;
      if (node.raycast) material.side = node.unlit && (this.viewMode === "ORBIT" || this.overviewReturnBlend !== null) ? THREE.FrontSide : THREE.DoubleSide;
      material.depthWrite = effectiveOpacity >= 1 || occluder;
      material.depthTest = effectiveOpacity >= 1 || this.overviewReturnBlend !== null || occluder;
      material.colorWrite = !occluder;
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

  private isReplaced(record: SceneGraphRecord) {
    return Boolean(record.node.raycast || record.node.replacedByReconstruction);
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
