import * as THREE from "three";
import type { SplatConfig } from "@/lib/types";
import type { SparkDyno, SplatHost, SplatModifier } from "@/lib/experience/registry";
import { applyTransform } from "@/lib/three/math";

type SparkModule = typeof import("@sparkjsdev/spark");
/** A splat role: the capture itself, or a companion trained on line drawings or watercolor versions of its photos. */
export type SplatRole = "color" | "sketch" | "watercolor";
const TRANSITION_CODES: Record<string, number> = { cut: 0, fade: 1, dissolve: 2, wipe: 3, iris: 4, sweep: 5, glitch: 6 };
const ROLE_CODES: Record<SplatRole, number> = { color: 0, sketch: 1, watercolor: 2 };
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
  private readonly modifiers: { modifier: SplatModifier; role: SplatRole }[] = [];
  private readonly roles = new WeakMap<object, SplatRole>();
  private readonly loading = new Map<SplatRole, Promise<boolean>>();
  private SplatMeshClass: SparkModule["SplatMesh"] | null = null;
  private fileTypes: SparkModule["SplatFileType"] | null = null;
  /** Looks: which companion shows, how far it has replaced the capture, and splat styling. */
  private look: ReturnType<SparkSplatLayer["createLookUniforms"]> | null = null;
  private lookVariant: SplatRole | null = null;
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
    this.SplatMeshClass = SplatMesh;
    this.fileTypes = SplatFileType;
    this.look = this.createLookUniforms();
    this.onProgress(0, 1, "Preparing Spark");

    this.spark = new SparkRenderer({
      renderer: this.renderer,
      ...this.rendererOptions
    });
    this.scene.add(this.spark);

    // Companions trained on drawings load when a look or effect first asks for them.
    await Promise.all(
      this.configs.map(async (config, index) => {
        if (this.roleOf(config) !== "color") return;
        await this.loadSplat(config, index, true);
      })
    );
  }

  private roleOf(config: SplatConfig): SplatRole {
    return config.role === "sketch" || config.role === "watercolor" ? config.role : "color";
  }

  /** Load a companion version of the space; resolves to whether this space has one. */
  prepareVariant(role: SplatRole): Promise<boolean> {
    if (role === "color") return Promise.resolve(true);
    let request = this.loading.get(role);
    if (!request) {
      const configs = this.configs.map((config, index) => ({ config, index })).filter(({ config }) => this.roleOf(config) === role);
      request = configs.length && this.SplatMeshClass
        ? Promise.all(configs.map(({ config, index }) => this.loadSplat(config, index, false))).then(() => true, (error) => {
          console.warn(`Unable to load the ${role} version of this space`, error);
          return false;
        })
        : Promise.resolve(false);
      this.loading.set(role, request);
    }
    return request;
  }

  private async loadSplat(config: SplatConfig, index: number, primary: boolean) {
    const SplatMesh = this.SplatMeshClass!;
    const SplatFileType = this.fileTypes!;
    {
      {
        const label = config.id ?? `splat-${index}`;
        const report = primary ? this.onProgress : () => {};
        const fileBytes = await this.loadFileBytes(config, label, report);
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
            report(event.loaded, event.total || 0, label);
          }
        });

        applyTransform(mesh, config);
        const role = this.roleOf(config);
        this.roles.set(mesh, role);
        mesh.opacity = config.reveal ? 0 : config.opacity ?? 1;
        if (role !== "color") mesh.visible = role === this.lookVariant;
        this.applyModifiers(mesh);
        this.scene.add(mesh);
        this.splats.push(mesh);
        await mesh.initialized;
        report(1, 1, `Loaded ${label}`);
        if (config.reveal) this.reveal();
      }
    }
  }

  private async loadFileBytes(config: SplatConfig, label: string, report: (loaded: number, total: number, label: string) => void = this.onProgress) {
    const response = await fetch(config.url, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(`Failed to load ${config.url}: ${response.status} ${response.statusText}`);
    }

    const total = Number(response.headers.get("content-length") ?? "0") || 0;
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      report(buffer.byteLength, buffer.byteLength, label);
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
      report(loaded, total, label);
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
        const show = () => this.splats.forEach((mesh) => { if (this.roles.get(mesh) === "sketch") mesh.visible = visible; });
        if (visible) void this.prepareVariant("sketch").then(show); else show();
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
    return this.splats.filter((mesh) => this.roles.get(mesh) === "color");
  }

  private createLookUniforms() {
    const dyno = this.dyno!;
    return {
      amount: dyno.dynoFloat(0),
      mode: dyno.dynoFloat(0),
      variant: dyno.dynoFloat(0),
      origin: dyno.dynoVec3(new THREE.Vector3()),
      direction: dyno.dynoVec3(new THREE.Vector3(0, -1, 0)),
      right: dyno.dynoVec3(new THREE.Vector3(1, 0, 0)),
      scale: dyno.dynoFloat(1),
      opacity: dyno.dynoFloat(1)
    };
  }

  /**
   * Looks: replace the capture with a companion drawn version as far as `amount`,
   * revealed per splat the way the transition says (a cone opening from the
   * viewer for a sweep or iris, a random dissolve, a sideways wipe).
   */
  showVariant(role: SplatRole | null, amount: number, transition: string, camera: THREE.Camera, direction: THREE.Vector3) {
    const look = this.look;
    if (!look) return;
    const variant = role && role !== "color" && this.splats.some((mesh) => this.roles.get(mesh) === role) ? role : null;
    const value = variant ? amount : 0;
    const changed = variant !== this.lookVariant || look.amount.value !== value;
    if (!changed) return;
    this.lookVariant = variant;
    look.amount.value = value;
    look.variant.value = variant ? ROLE_CODES[variant] : 0;
    look.mode.value = TRANSITION_CODES[transition] ?? 1;
    look.origin.value.copy(camera.position);
    look.direction.value.copy(direction);
    look.right.value.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.splats.forEach((mesh) => {
      const role = this.roles.get(mesh);
      if (role === "color") mesh.visible = !variant || value < 1;
      else if (role === this.lookVariant) mesh.visible = value > 0;
      else if (role !== "sketch") mesh.visible = false;
    });
    this.regenerate = true;
  }

  /** Whether a companion version has loaded. */
  variantReady(role: SplatRole) {
    return this.splats.some((mesh) => this.roles.get(mesh) === role);
  }

  /** Looks: shrink, fade or flatten splats, blended by amount. */
  styleSplats(style: { scale?: number; opacity?: number; falloff?: number } | null, amount: number) {
    const look = this.look;
    if (!look) return;
    const scale = 1 + ((style?.scale ?? 1) - 1) * amount;
    const opacity = 1 + ((style?.opacity ?? 1) - 1) * amount;
    if (this.spark) this.spark.falloff = 1 + ((style?.falloff ?? 1) - 1) * amount;
    if (look.scale.value === scale && look.opacity.value === opacity) return;
    look.scale.value = scale;
    look.opacity.value = opacity;
    this.regenerate = true;
  }

  /** While a look renders offscreen, splats write linear color like the rest of the scene. */
  setLinearOutput(linear: boolean) {
    if (this.spark) this.spark.encodeLinear = linear;
  }

  private lookModifier(role: SplatRole): SplatModifier {
    const look = this.look!;
    const variant = role !== "color";
    return (dyno, gsplat) => {
      const node = new dyno.Dyno({
        inTypes: { gsplat: dyno.Gsplat, amount: "float", mode: "float", variant: "float", origin: "vec3", direction: "vec3", right: "vec3", scale: "float", opacity: "float" },
        outTypes: { gsplat: dyno.Gsplat },
        statements: ({ inputs, outputs }) => dyno.unindentLines(`
          ${outputs.gsplat} = ${inputs.gsplat};
          vec3 lookRay = normalize(${inputs.gsplat}.center - ${inputs.origin});
          float lookAmount = ${inputs.amount};
          float lookMode = ${inputs.mode};
          float lookMask = lookAmount;
          if (lookMode < 0.5) lookMask = step(0.5, lookAmount);
          else if (lookMode < 1.5) lookMask = lookAmount;
          else if (lookMode < 2.5) lookMask = step(fract(sin(dot(${inputs.gsplat}.center, vec3(12.9898, 78.233, 37.719))) * 43758.5453), lookAmount);
          else if (lookMode < 3.5) lookMask = step(dot(lookRay, ${inputs.right}) * 0.5 + 0.5, lookAmount * 1.2 - 0.1);
          else if (lookMode < 5.5) lookMask = step(acos(clamp(dot(lookRay, ${inputs.direction}), -1.0, 1.0)), lookAmount * 3.5 - 0.1);
          else lookMask = step(fract(sin(dot(floor(${inputs.gsplat}.center * 2.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453), lookAmount);
          // The capture gives way where the drawn version arrives; other companions are left to their effects.
          float lookShow = ${variant ? `mix(1.0, lookMask, step(abs(${inputs.variant} - ${ROLE_CODES[role].toFixed(1)}), 0.1))` : `1.0 - lookMask * step(0.5, ${inputs.variant})`};
          ${outputs.gsplat}.rgba.a *= lookShow * ${inputs.opacity};
          ${outputs.gsplat}.scales *= ${inputs.scale};
        `)
      });
      return node.apply({ gsplat, amount: look.amount, mode: look.mode, variant: look.variant, origin: look.origin,
        direction: look.direction, right: look.right, scale: look.scale, opacity: look.opacity }).gsplat;
    };
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
      if (this.roles.get(mesh) !== "color") continue;
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
    if (this.look) modifiers.push(this.lookModifier(role));
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
      if (this.roles.get(mesh) === "color") mesh.visible = visible;
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
