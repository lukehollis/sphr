import * as THREE from "three";
import type { ColorConfig, SkyboxConfig } from "@/lib/types";

type SkyboxMode = "day" | "night";

function colorFromConfig(value: ColorConfig | undefined, fallback: ColorConfig) {
  const colorValue = value ?? fallback;
  if (Array.isArray(colorValue)) return new THREE.Color(colorValue[0], colorValue[1], colorValue[2]);
  return new THREE.Color(colorValue);
}

function rotationFor(mode: SkyboxMode, config: SkyboxConfig) {
  if (mode === "night" && config.nightRotation) return config.nightRotation;
  if (mode === "day" && config.dayRotation) return config.dayRotation;
  return config.rotation ?? [0, 0, 0];
}

function clampOpacity(value: number | undefined, fallback: number) {
  return THREE.MathUtils.clamp(value ?? fallback, 0, 1);
}

export class SkyboxLayer {
  private readonly textureLoader: THREE.TextureLoader;
  private readonly cubeLoader: THREE.CubeTextureLoader;
  private geometry: THREE.SphereGeometry | null = null;
  private material: THREE.MeshBasicMaterial | null = null;
  private mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null = null;
  private dayTexture: THREE.Texture | null = null;
  private nightTexture: THREE.Texture | null = null;
  private cubeTexture: THREE.CubeTexture | null = null;
  private fadeFrame: number | null = null;
  private mode: SkyboxMode = "day";
  private loaded = false;
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly manager: THREE.LoadingManager,
    private readonly config: SkyboxConfig
  ) {
    this.textureLoader = new THREE.TextureLoader(manager);
    this.cubeLoader = new THREE.CubeTextureLoader(manager);
  }

  async init() {
    if (this.config.visible === false) return;

    if (this.config.backgroundColor !== undefined) {
      this.scene.background = colorFromConfig(this.config.backgroundColor, 0x222222);
    }

    const type = this.config.type ?? (this.getCubeFaces()?.length === 6 ? "cube" : "equirectangular");
    if (type === "color") {
      this.scene.background = colorFromConfig(this.config.backgroundColor, 0x222222);
      this.loaded = true;
      return;
    }

    if (type === "cube") {
      await this.initCube();
      return;
    }

    await this.initEquirectangularSphere();
  }

  update(camera: THREE.Camera) {
    if (this.mesh) this.mesh.position.copy(camera.position);
  }

  changeToDay() {
    this.setMode("day");
  }

  changeToNight() {
    this.setMode("night");
  }

  fadeIn(duration = this.config.fadeInMs ?? 600) {
    this.fadeTo(clampOpacity(this.config.opacity, 1), duration);
  }

  fadeOut(duration = this.config.fadeOutMs ?? 600) {
    this.fadeTo(0, duration);
  }

  getDebugSnapshot() {
    return {
      id: this.config.id ?? null,
      loaded: this.loaded,
      mode: this.mode,
      type: this.config.type ?? (this.getCubeFaces()?.length === 6 ? "cube" : "equirectangular"),
      visible: this.mesh?.visible ?? Boolean(this.cubeTexture || this.loaded),
      opacity: this.material?.opacity ?? null,
      dayTexture: this.config.day ?? this.config.url ?? null,
      nightTexture: this.config.night ?? null,
      rotation: this.mesh?.rotation.toArray().slice(0, 3) ?? null
    };
  }

  dispose() {
    this.disposed = true;
    if (this.fadeFrame !== null) {
      cancelAnimationFrame(this.fadeFrame);
      this.fadeFrame = null;
    }

    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh = null;
    }
    this.geometry?.dispose();
    this.geometry = null;
    this.material?.dispose();
    this.material = null;
    this.dayTexture?.dispose();
    this.dayTexture = null;
    this.nightTexture?.dispose();
    this.nightTexture = null;
    this.cubeTexture?.dispose();
    this.cubeTexture = null;
  }

  private async initEquirectangularSphere() {
    const dayUrl = this.config.day ?? this.config.url;
    if (!dayUrl) return;

    const [dayTexture, nightTexture] = await Promise.all([
      this.loadTexture(dayUrl),
      this.config.night ? this.loadTexture(this.config.night) : Promise.resolve(null)
    ]);
    if (this.disposed) return;

    this.dayTexture = dayTexture;
    this.nightTexture = nightTexture;

    this.geometry = new THREE.SphereGeometry(
      this.config.radius ?? 500,
      this.config.widthSegments ?? 60,
      this.config.heightSegments ?? 40
    );
    this.geometry.scale(-1, 1, 1);

    this.material = new THREE.MeshBasicMaterial({
      map: dayTexture,
      color: colorFromConfig(this.config.tint, [0.5, 0.5, 0.5]),
      fog: false,
      transparent: true,
      opacity: clampOpacity(this.config.initialOpacity, this.config.fadeInMs === 0 ? this.config.opacity ?? 1 : 0),
      depthWrite: false,
      depthTest: true
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = this.config.id ?? "sphr-skybox";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.applyRotation("day");
    this.scene.add(this.mesh);
    this.loaded = true;

    if ((this.config.fadeInMs ?? 600) > 0) this.fadeIn();
  }

  private async initCube() {
    const faces = this.getCubeFaces();
    if (!faces || faces.length !== 6) return;

    this.cubeTexture = await this.cubeLoader.loadAsync(faces);
    if (this.disposed) return;

    this.cubeTexture.colorSpace = THREE.SRGBColorSpace;
    this.cubeTexture.needsUpdate = true;
    this.scene.background = this.cubeTexture;
    this.loaded = true;
  }

  private async loadTexture(url: string) {
    const texture = await this.textureLoader.loadAsync(url);
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 8;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  private setMode(mode: SkyboxMode) {
    this.mode = mode;

    if (this.mesh && this.material) {
      const texture = mode === "night" ? this.nightTexture ?? this.dayTexture : this.dayTexture;
      if (texture) {
        this.material.map = texture;
        this.material.color = colorFromConfig(
          mode === "night" ? this.config.nightTint ?? this.config.tint : this.config.tint,
          [0.5, 0.5, 0.5]
        );
        this.material.needsUpdate = true;
      }
      this.applyRotation(mode);
    }

    if (mode === "night" && !this.nightTexture && this.config.nightBackgroundColor !== undefined) {
      this.scene.background = colorFromConfig(this.config.nightBackgroundColor, 0x211342);
    }
  }

  private applyRotation(mode: SkyboxMode) {
    if (!this.mesh) return;
    const rotation = rotationFor(mode, this.config);
    this.mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  }

  private fadeTo(target: number, duration: number) {
    if (!this.material) return;
    if (this.fadeFrame !== null) cancelAnimationFrame(this.fadeFrame);

    const start = performance.now();
    const initial = this.material.opacity;
    const safeDuration = Math.max(0, duration);

    const tick = () => {
      if (this.disposed || !this.material) return;
      const value = safeDuration === 0 ? 1 : Math.min(1, (performance.now() - start) / safeDuration);
      const eased = 1 - Math.pow(1 - value, 3);
      this.material.opacity = initial + (target - initial) * eased;

      if (value < 1) {
        this.fadeFrame = requestAnimationFrame(tick);
      } else {
        this.material.opacity = target;
        this.fadeFrame = null;
      }
    };

    this.fadeFrame = requestAnimationFrame(tick);
  }

  private getCubeFaces() {
    return this.config.faces ?? this.config.cubeFaces;
  }
}
