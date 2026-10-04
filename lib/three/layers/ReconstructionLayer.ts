import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ReconstructionConfig } from "@/lib/types";
import { parseReconstruction, reconstructionModelUrl } from "@/lib/reconstruction";

type LoadState = "idle" | "loading" | "ready" | "failed";

/**
 * A stylized model of what a site once looked like, built offline as one GLB
 * and placed in the space's coordinates by its manifest. It stands in for the
 * capture mesh in the dollhouse and for the photographs in first person, and
 * loads only when it is about to be seen. A model that cannot load leaves the
 * viewer as it was.
 */
export class ReconstructionLayer {
  /** Puts the model where the manifest says, in the space's coordinates. */
  readonly group = new THREE.Group();
  /** A plain sky behind the model in first person, where the photographs had theirs. */
  private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly materials: THREE.Material[] = [];
  private readonly meshes: THREE.Mesh[] = [];
  private config: ReconstructionConfig | null;
  private manifestUrl: string | null;
  private state: LoadState = "idle";
  private loading: Promise<boolean> | null = null;
  private opacity = 0;
  private disposed = false;
  private error: string | null = null;

  constructor(private readonly scene: THREE.Scene, source: string | ReconstructionConfig) {
    this.group.name = "reconstruction";
    this.group.visible = false;
    this.manifestUrl = typeof source === "string" ? source : null;
    this.config = typeof source === "string" ? null : parseReconstruction(source);
    if (typeof source !== "string" && !this.config) this.fail("The reconstruction's manifest is invalid.");
    this.sky = createSky();
    this.scene.add(this.group, this.sky);
  }

  get ready() { return this.state === "ready"; }
  get failed() { return this.state === "failed"; }
  get busy() { return this.state === "loading"; }
  get visible() { return this.group.visible; }
  get info() { return { title: this.config?.title, credit: this.config?.credit }; }

  /** Fetch the manifest and the model, once. Resolves false when either cannot be used. */
  load(): Promise<boolean> {
    this.loading ??= this.create().then((loaded) => {
      if (!loaded && !this.disposed) this.fail(this.error ?? "The reconstruction could not load.");
      return loaded;
    }, (error) => {
      this.fail(error instanceof Error ? error.message : String(error));
      return false;
    });
    return this.loading;
  }

  /**
   * 0 hides the model, 1 shows it solid. Between, it is see-through and writes
   * depth only once nearly solid, so a fade never hides what is behind it.
   */
  setOpacity(value: number) {
    const opacity = this.ready ? THREE.MathUtils.clamp(value, 0, 1) : 0;
    if (Math.abs(opacity - this.opacity) < 1e-4 && this.group.visible === (opacity > 0)) return;
    this.opacity = opacity;
    this.group.visible = opacity > 0;
    if (!this.group.visible) return;
    const transparent = opacity < 1;
    for (const material of this.materials) {
      if (material.transparent !== transparent) {
        material.transparent = transparent;
        material.needsUpdate = true;
      }
      const base = material.userData.reconstructionOpacity;
      material.opacity = (typeof base === "number" ? base : 1) * opacity;
      material.depthWrite = opacity > 0.9;
    }
  }

  /** The sky behind the model, for first person. */
  setSky(value: number) {
    const opacity = this.ready ? THREE.MathUtils.clamp(value, 0, 1) : 0;
    this.sky.visible = opacity > 0.001;
    this.sky.material.uniforms.opacity.value = opacity;
  }

  update(camera: THREE.Camera) {
    if (this.sky.visible) this.sky.position.copy(camera.position);
  }

  /** The model's surfaces for clicks and wall tests, only while it shows. */
  getRaycastObjects(): THREE.Object3D[] {
    return this.group.visible ? [this.group] : [];
  }

  getBounds(out = new THREE.Box3()) {
    out.makeEmpty();
    if (!this.ready) return out;
    this.group.updateMatrixWorld(true);
    return out.setFromObject(this.group);
  }

  /** Named places from the manifest, in the space's coordinates. */
  landmarks() {
    this.group.updateMatrixWorld(true);
    return (this.config?.landmarks ?? []).map((landmark) => ({
      name: landmark.name,
      position: new THREE.Vector3(...landmark.position).applyMatrix4(this.group.matrixWorld)
    }));
  }

  getDebugSnapshot() {
    return {
      state: this.state,
      error: this.error,
      manifest: this.manifestUrl,
      title: this.config?.title ?? null,
      opacity: this.opacity,
      visible: this.group.visible,
      sky: this.sky.visible ? this.sky.material.uniforms.opacity.value : 0,
      meshes: this.meshes.length,
      landmarks: this.landmarks().map((landmark) => ({ name: landmark.name, position: landmark.position.toArray().map((value) => Number(value.toFixed(3))) }))
    };
  }

  dispose() {
    this.disposed = true;
    this.scene.remove(this.group, this.sky);
    this.group.traverse((child) => (child as THREE.Mesh).geometry?.dispose?.());
    for (const material of this.materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
      material.dispose();
    }
    this.materials.length = 0;
    this.meshes.length = 0;
    this.group.clear();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
  }

  private fail(message: string) {
    if (this.state === "failed") return;
    this.state = "failed";
    this.error = message;
    this.group.visible = false;
    this.sky.visible = false;
    console.warn(`Reconstruction unavailable: ${message}`);
  }

  private async create() {
    if (this.state === "failed") return false;
    this.state = "loading";
    const page = typeof window === "undefined" ? "http://localhost/" : window.location.href;
    if (!this.config && this.manifestUrl) {
      const response = await fetch(new URL(this.manifestUrl, page), { credentials: "omit" });
      if (!response.ok) { this.error = `The manifest returned HTTP ${response.status}.`; return false; }
      this.config = parseReconstruction(await response.json());
      if (!this.config) { this.error = "The manifest is invalid."; return false; }
    }
    if (!this.config || this.disposed) return false;
    const url = reconstructionModelUrl(this.config, this.manifestUrl, page);
    if (!url) { this.error = "The model's address is not allowed."; return false; }
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
    loader.setDRACOLoader(draco);
    let gltf;
    try { gltf = await loader.loadAsync(url); }
    finally { draco.dispose(); }
    if (this.disposed) {
      gltf.scene.traverse((child) => (child as THREE.Mesh).geometry?.dispose?.());
      return false;
    }
    const model = gltf.scene;
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.meshes.push(mesh);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!material || this.materials.includes(material)) continue;
        // Vertex colors (weathering and paint) multiply the base color texture.
        if (mesh.geometry.attributes.color && "vertexColors" in material) material.vertexColors = true;
        material.userData.reconstructionOpacity = material.opacity;
        material.needsUpdate = true;
        this.materials.push(material);
      }
    });
    const config = this.config;
    this.sky.material.uniforms.zenith.value = displayColor(config.sky?.zenith, SKY.zenith);
    this.sky.material.uniforms.horizon.value = displayColor(config.sky?.horizon, SKY.horizon);
    if (config.position) this.group.position.fromArray(config.position);
    if (config.quaternion) this.group.quaternion.fromArray(config.quaternion).normalize();
    if (config.scale) this.group.scale.setScalar(config.scale);
    this.group.add(model);
    this.group.updateMatrixWorld(true);
    // Hidden until the viewer fades it in.
    this.state = "ready";
    this.opacity = 0;
    this.group.visible = false;
    return true;
  }
}

const SKY = { zenith: "#5f95cf", horizon: "#dfe8ef" };

/** A #rrggbb color as display values, the way the sky shader writes them. */
function displayColor(hex: string | undefined, fallback: string) {
  const value = /^#[0-9a-f]{6}$/i.test(hex ?? "") ? hex! : fallback;
  return new THREE.Vector3(...[1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16) / 255));
}

/**
 * Pale at the horizon, deeper overhead and a little warm below, like a clear
 * day over the sea. It sits at the far end of the depth range, so it fills only
 * where the model and its distant scenery leave the view empty.
 */
function createSky() {
  const material = new THREE.ShaderMaterial({
    uniforms: { opacity: { value: 0 }, zenith: { value: displayColor(SKY.zenith, SKY.zenith) }, horizon: { value: displayColor(SKY.horizon, SKY.horizon) } },
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w * 0.999999;
      }`,
    fragmentShader: `
      uniform float opacity;
      uniform vec3 zenith;
      uniform vec3 horizon;
      varying vec3 vDirection;
      void main() {
        float up = vDirection.y;
        vec3 below = mix(horizon, vec3(0.93, 0.88, 0.80), 0.35);
        vec3 color = up >= 0.0 ? mix(horizon, zenith, smoothstep(0.0, 0.6, up)) : mix(horizon, below, smoothstep(0.0, 0.25, -up));
        gl_FragColor = vec4(color, opacity);
      }`,
    side: THREE.BackSide,
    // Drawn after the solid model, so it fills only where nothing is in front.
    depthWrite: false,
    transparent: true,
    toneMapped: false,
    fog: false
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(8000, 32, 16), material);
  sky.name = "reconstruction-sky";
  // Behind the photographs as they fade, so the sky never washes over them.
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  sky.visible = false;
  return sky;
}
