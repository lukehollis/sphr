import * as THREE from "three";
import type { SplatConfig } from "@/lib/types";
import type { SparkDyno, SplatHost, SplatModifier } from "@/lib/experience/registry";
import { applyTransform } from "@/lib/three/math";

type SparkModule = typeof import("@sparkjsdev/spark");
type SparkRendererInstance = InstanceType<SparkModule["SparkRenderer"]>;
type SplatMeshInstance = InstanceType<SparkModule["SplatMesh"]>;

export class SparkSplatLayer {
  private spark: SparkRendererInstance | null = null;
  private readonly splats: SplatMeshInstance[] = [];
  private readonly rendererOptions = {
    maxStdDev: Math.sqrt(8),
    sortRadial: false,
    focalAdjustment: 2.0
  };
  private disposed = false;
  private dyno: SparkDyno | null = null;
  private readonly modifiers: { modifier: SplatModifier; role: "color" | "sketch" }[] = [];
  private readonly roles = new WeakMap<object, "color" | "sketch">();
  private unpack: typeof import("@sparkjsdev/spark").unpackSplat | null = null;
  private bounds: THREE.Box3 | null = null;
  private regenerate = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly configs: SplatConfig[],
    private readonly onProgress: (loaded: number, total: number, label: string) => void
  ) {}

  async init() {
    if (!this.configs.length) return;
    const { SparkRenderer, SplatMesh, SplatFileType, dyno, unpackSplat } = await import("@sparkjsdev/spark");
    if (this.disposed) return;
    this.dyno = dyno;
    this.unpack = unpackSplat;
    this.onProgress(0, 1, "Preparing Spark");

    this.spark = new SparkRenderer({
      renderer: this.renderer,
      ...this.rendererOptions
    });
    this.scene.add(this.spark);

    await Promise.all(
      this.configs.map(async (config, index) => {
        const label = config.id ?? `splat-${index}`;
        const fileBytes = await this.loadFileBytes(config, label);
        const fileType =
          config.fileType === "splat" || /\.splat(\?|#|$)/i.test(config.url)
            ? SplatFileType.SPLAT
            : config.fileType === "ply" || /\.ply(\?|#|$)/i.test(config.url)
              ? SplatFileType.PLY
              : config.fileType === "spz" || /\.spz(\?|#|$)/i.test(config.url)
                ? SplatFileType.SPZ
                : config.fileType === "ksplat" || /\.ksplat(\?|#|$)/i.test(config.url)
                  ? SplatFileType.KSPLAT
                  : config.fileType === "rad" || /\.rad(\?|#|$)/i.test(config.url)
                    ? SplatFileType.RAD
                    : undefined;

        this.onProgress(0.96, 1, `Decoding ${label}`);
        const mesh = new SplatMesh({
          fileBytes,
          fileType,
          fileName: config.url,
          lod: config.lod ?? true,
          onProgress: (event) => {
            this.onProgress(event.loaded, event.total || 0, label);
          }
        });

        applyTransform(mesh, config);
        const role = config.role === "sketch" ? "sketch" : "color";
        this.roles.set(mesh, role);
        mesh.opacity = config.reveal ? 0 : config.opacity ?? 1;
        if (role === "sketch") mesh.visible = false;
        if (this.modifiers.length) this.applyModifiers(mesh);
        this.scene.add(mesh);
        this.splats.push(mesh);
        await mesh.initialized;
        this.onProgress(1, 1, `Loaded ${label}`);
        if (config.reveal) this.reveal();
      })
    );
  }

  private async loadFileBytes(config: SplatConfig, label: string) {
    const response = await fetch(config.url, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(`Failed to load ${config.url}: ${response.status} ${response.statusText}`);
    }

    const total = Number(response.headers.get("content-length") ?? "0") || 0;
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      this.onProgress(buffer.byteLength, buffer.byteLength, label);
      return new Uint8Array(buffer);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      this.onProgress(loaded, total, label);
    }

    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  reveal(duration = 1600) {
    const start = performance.now();
    const tick = () => {
      const value = Math.min(1, (performance.now() - start) / duration);
      const eased = 1 - Math.pow(1 - value, 3);
      this.splats.forEach((mesh) => {
        mesh.opacity = eased;
        const scale = 0.96 + eased * 0.04;
        mesh.scale.setScalar(scale);
      });
      if (value < 1 && !this.disposed) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  setStudyMode(mode?: string) {
    if (!this.splats.length) return;
    if (mode === "nightMode") {
      this.splats.forEach((mesh) => {
        mesh.recolor.set(0.58, 0.66, 0.9);
        mesh.opacity = 0.92;
      });
      return;
    }

    if (mode === "shrinkToPoints") {
      this.splats.forEach((mesh) => {
        mesh.recolor.set(1.15, 1.08, 0.82);
        mesh.opacity = 0.62;
        mesh.scale.setScalar(0.985);
      });
      return;
    }

    if (mode === "projectToSplats") {
      this.splats.forEach((mesh) => {
        mesh.recolor.set(1.2, 1.16, 1.0);
        mesh.opacity = 0.82;
        mesh.scale.setScalar(1.01);
      });
      return;
    }

    this.splats.forEach((mesh) => {
      mesh.recolor.set(1, 1, 1);
      mesh.opacity = 1;
      mesh.scale.setScalar(1);
    });
  }

  /** Effects rewrite splats through world-space modifiers chained in one block. */
  splatHost(): SplatHost | null {
    const dyno = this.dyno;
    if (!dyno) return null;
    return {
      dyno,
      addModifier: (modifier, role = "color") => {
        const entry = { modifier, role };
        this.modifiers.push(entry);
        this.splats.forEach((mesh) => this.applyModifiers(mesh));
        return () => {
          const index = this.modifiers.indexOf(entry);
          if (index >= 0) this.modifiers.splice(index, 1);
          this.splats.forEach((mesh) => this.applyModifiers(mesh));
        };
      },
      hasSketch: this.configs.some((config) => config.role === "sketch"),
      showSketch: (visible) => {
        this.splats.forEach((mesh) => { if (this.roles.get(mesh) === "sketch") mesh.visible = visible; });
      },
      invalidate: () => { this.regenerate = true; }
    };
  }

  /** Regenerate splats once per frame when an effect changed its uniforms. */
  update() {
    if (!this.regenerate) return;
    this.regenerate = false;
    this.splats.forEach((mesh) => mesh.updateVersion());
  }

  getMeshes(): THREE.Object3D[] {
    return this.splats.filter((mesh) => this.roles.get(mesh) !== "sketch");
  }

  /**
   * Bounds of the captured splats from a sample of centers, trimmed of the
   * stray floaters at the edges that would otherwise inflate them.
   */
  getBounds(out: THREE.Box3) {
    if (this.bounds) return out.copy(this.bounds);
    out.makeEmpty();
    const unpack = this.unpack;
    if (!unpack) return out;
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    const point = new THREE.Vector3();
    for (const mesh of this.splats) {
      if (this.roles.get(mesh) === "sketch") continue;
      // After building its level of detail, Spark may keep only the LoD splats.
      const packed = mesh.packedSplats?.packedArray && mesh.packedSplats.getNumSplats() ? mesh.packedSplats : mesh.packedSplats?.lodSplats;
      const array = packed?.packedArray;
      const count = packed?.getNumSplats() ?? 0;
      if (!array || !count) continue;
      mesh.updateMatrixWorld(true);
      const step = Math.max(1, Math.floor(count / 20000));
      for (let index = 0; index < count; index += step) {
        const splat = unpack(array, index, packed!.splatEncoding);
        if (splat.opacity < 0.2) continue;
        point.copy(splat.center).applyMatrix4(mesh.matrixWorld);
        xs.push(point.x); ys.push(point.y); zs.push(point.z);
      }
    }
    if (xs.length < 10) return out;
    const range = (values: number[]) => {
      values.sort((a, b) => a - b);
      return [values[Math.floor(values.length * 0.02)], values[Math.floor(values.length * 0.98)]];
    };
    const [minX, maxX] = range(xs), [minY, maxY] = range(ys), [minZ, maxZ] = range(zs);
    this.bounds = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ));
    return out.copy(this.bounds);
  }

  private applyModifiers(mesh: SplatMeshInstance) {
    const dyno = this.dyno;
    if (!dyno) return;
    const role = this.roles.get(mesh) ?? "color";
    const modifiers = this.modifiers.filter((entry) => entry.role === role).map((entry) => entry.modifier);
    mesh.worldModifiers = modifiers.length ? [dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
      if (!gsplat) throw new Error("No splat input");
      let value = gsplat;
      for (const modifier of modifiers) value = modifier(dyno, value);
      return { gsplat: value };
    })] : undefined;
    mesh.updateGenerator();
    this.regenerate = true;
  }

  setVisible(visible: boolean) {
    this.spark && (this.spark.visible = visible);
    this.splats.forEach((mesh) => {
      if (this.roles.get(mesh) !== "sketch") mesh.visible = visible;
    });
  }

  getDebugSnapshot() {
    return {
      renderer: this.rendererOptions,
      splats: this.splats.map((mesh) => {
        const maybeCount = mesh as SplatMeshInstance & { numSplats?: number };
        return {
          visible: mesh.visible,
          opacity: mesh.opacity,
          scale: mesh.scale.x,
          numSplats: maybeCount.numSplats ?? null
        };
      })
    };
  }

  dispose() {
    this.disposed = true;
    this.splats.forEach((mesh) => {
      this.scene.remove(mesh);
      mesh.dispose();
    });
    this.splats.length = 0;
    if (this.spark) {
      this.scene.remove(this.spark);
      this.spark.geometry?.dispose();
      this.spark.material?.dispose();
      this.spark = null;
    }
  }
}
