import * as THREE from "three";
import { lookEntry } from "@/lib/experience/packs";
import { resolveParams, type LookMeta } from "@/lib/experience/registry";
import type { EffectParams } from "@/lib/experience/types";
import type { LookTransition, StopLook } from "@/lib/experience/types";
import { LOOK_VERTEX, lookFragment } from "./shader";

/**
 * Looks restyle the whole frame, like filters and transitions in a video
 * editor. With no look the scene renders straight to the screen; with one,
 * it renders to an offscreen frame that a full-screen shader redraws.
 */

export type LookVariant = "sketch" | "watercolor";

/** What the runtime offers looks: other versions of the space, and splat styling. */
export type LookHost = {
  /** Load a version of the space drawn another way; resolves to whether this space has it. */
  prepareVariant(variant: LookVariant): Promise<boolean>;
  /** Blend the space toward a version (amount 0..1), revealed the way the transition says. */
  showVariant(variant: LookVariant | null, amount: number, transition: LookTransition, direction: THREE.Vector3, center: THREE.Vector2): void;
  /** Splat spaces: shrink or flatten splats, blended by amount. */
  styleSplats(style: LookMeta["splats"] | null, amount: number): void;
  /** Called while a look renders offscreen, so splats write linear color like the rest of the scene. */
  setLinearOutput(linear: boolean): void;
  /** Whether the drawn version is ready where the visitor is now (panoramas are drawn location by location). */
  variantReady(variant: LookVariant): boolean;
};

type Active = { meta: LookMeta | null; params: EffectParams; hasVariant: boolean; key: string };
type Transition = { from: Active; type: LookTransition; duration: number; elapsed: number; direction: THREE.Vector3; center: THREE.Vector2 };

const NONE: Active = { meta: null, params: {}, hasVariant: false, key: "color" };

export function lookKey(look: StopLook | null | undefined) {
  if (!look || look.look === "color") return "color";
  return `${look.look}:${JSON.stringify(look.params ?? {})}`;
}

export class LookPass {
  private current: Active = NONE;
  private transition: Transition | null = null;
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly materials = new Map<string, THREE.ShaderMaterial>();
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly size = new THREE.Vector2();
  private readonly rayX = new THREE.Vector3();
  private readonly rayY = new THREE.Vector3();
  private readonly rayZ = new THREE.Vector3();
  private requested = "color";
  /** Looks begin in the order asked for, each once its drawn version (if any) has loaded. */
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;
  private readonly floatTargets: boolean;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly host: LookHost, private readonly reducedMotion = false) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    const gl = renderer.getContext();
    this.floatTargets = Boolean(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
  }

  /** Whether anything is styled right now. */
  get active() { return Boolean(this.current.meta || this.transition); }
  get look() { return this.current.meta?.id ?? "color"; }

  /**
   * Change to a look, through a transition. `toward` is a world point the sweep
   * and iris open from (a target object, say); without it they open from where
   * the viewer looks (iris) or from the ground at the viewer's feet (sweep).
   */
  set(look: StopLook | null | undefined, camera: THREE.PerspectiveCamera, toward?: THREE.Vector3 | null, { instant = false } = {}) {
    const key = lookKey(look);
    if (key === this.requested && !instant) return;
    this.requested = key;
    const token = ++this.sequence;
    const meta = look && look.look !== "color" ? lookEntry(look.look) : null;
    const next: Active = { meta, params: meta ? resolveParams(meta, look?.params) : {}, hasVariant: false, key };
    const type = look?.transition ?? (this.current.meta || meta ? "fade" : "cut");
    const duration = instant ? 0 : this.reducedMotion ? Math.min(0.3, look?.duration ?? 1.2) : look?.duration ?? (type === "cut" ? 0 : type === "sweep" || type === "iris" ? 2.2 : 1.2);
    const begin = (hasVariant: boolean) => {
      // A newer look replaces this one, unless this is the opening look a stop transitions from.
      if (token !== this.sequence && !instant) return;
      next.hasVariant = hasVariant;
      const direction = new THREE.Vector3(0, -1, 0);
      const center = new THREE.Vector2(0.5, 0.5);
      if (toward) {
        direction.copy(toward).sub(camera.position).normalize();
        const projected = toward.clone().project(camera);
        if (projected.z < 1) center.set((projected.x + 1) / 2, (projected.y + 1) / 2);
      }
      const from = this.transition ? this.settle() : this.current;
      this.current = next;
      this.transition = duration > 0 && type !== "cut" ? { from, type, duration, elapsed: 0, direction, center } : null;
      this.applyHost(this.transition ? 0 : 1);
    };
    const ready = meta?.variant ? this.host.prepareVariant(meta.variant).catch(() => false) : Promise.resolve(false);
    this.queue = this.queue.then(() => ready).then(begin);
  }

  /** Step a transition forward; returns true while frames must keep changing. */
  update(delta: number) {
    if (!this.transition) return false;
    this.transition.elapsed += delta;
    const progress = Math.min(1, this.transition.elapsed / this.transition.duration);
    this.applyHost(progress);
    if (progress >= 1) this.transition = null;
    return true;
  }

  private settle() {
    const finished = this.current;
    this.transition = null;
    return finished;
  }

  private applyHost(progress: number) {
    const transition = this.transition;
    const to = this.current;
    const from = transition?.from ?? NONE;
    const variant = to.hasVariant ? to.meta?.variant ?? null : null;
    const previous = from.hasVariant ? from.meta?.variant ?? null : null;
    const type = transition?.type ?? "cut";
    const direction = transition?.direction ?? new THREE.Vector3(0, -1, 0);
    const center = transition?.center ?? new THREE.Vector2(0.5, 0.5);
    // Going to a drawn version reveals it; leaving one hides it the same way.
    if (variant && variant === previous) this.host.showVariant(variant, 1, type, direction, center);
    else if (variant) this.host.showVariant(variant, transition ? progress : 1, type, direction, center);
    else if (previous) this.host.showVariant(previous, transition ? 1 - progress : 0, type, direction, center);
    else this.host.showVariant(null, 0, type, direction, center);
    const style = to.meta?.splats ?? null;
    const fromStyle = from.meta?.splats ?? null;
    if (style) this.host.styleSplats(style, transition ? progress : 1);
    else if (fromStyle && transition) this.host.styleSplats(fromStyle, 1 - progress);
    else this.host.styleSplats(null, 0);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, time: number) {
    if (!this.active) {
      this.renderer.render(scene, camera);
      return;
    }
    const target = this.ensureTarget();
    this.host.setLinearOutput(true);
    this.renderer.setRenderTarget(target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.host.setLinearOutput(false);
    this.draw(target.texture, camera, time, null);
  }

  private draw(frame: THREE.Texture, camera: THREE.PerspectiveCamera, time: number, output: THREE.WebGLRenderTarget | null, only?: Active) {
    const transition = only ? null : this.transition;
    const to = only ?? this.current;
    const material = this.material(transition?.from ?? null, to, transition?.type ?? null);
    const uniforms = material.uniforms;
    uniforms.tFrame.value = frame;
    this.renderer.getDrawingBufferSize(this.size);
    if (output) this.size.set(output.width, output.height);
    uniforms.uResolution.value.copy(this.size);
    uniforms.uTime.value = time;
    uniforms.uProgress.value = transition ? Math.min(1, transition.elapsed / transition.duration) : 1;
    if (transition) {
      uniforms.uDirection.value.copy(transition.direction);
      uniforms.uCenter.value.copy(transition.center);
      const front = (to.meta?.params.find((spec) => spec.key === "front") ? to.params.front : null) as string | null;
      uniforms.uFrontColor.value.set(typeof front === "string" ? front : "#ffffff").multiplyScalar(transition.type === "glitch" ? 0.6 : 0.85);
    }
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    camera.matrixWorld.extractBasis(this.rayX, this.rayY, this.rayZ);
    uniforms.uRayX.value.copy(this.rayX).multiplyScalar(tan * camera.aspect);
    uniforms.uRayY.value.copy(this.rayY).multiplyScalar(tan);
    uniforms.uRayZ.value.copy(this.rayZ).negate();
    this.bind(uniforms, "B", to);
    if (transition) this.bind(uniforms, "A", transition.from);
    this.quad.material = material;
    this.renderer.setRenderTarget(output);
    this.renderer.render(this.quadScene, this.quadCamera);
    this.renderer.setRenderTarget(null);
  }

  private bind(uniforms: Record<string, THREE.IUniform>, slot: "A" | "B", look: Active) {
    if (!look.meta) return;
    for (const spec of look.meta.params) {
      const uniform = uniforms[`u${slot}_${spec.key}`];
      if (!uniform) continue;
      const value = look.params[spec.key];
      if (spec.type === "color") (uniform.value as THREE.Color).set(typeof value === "string" ? value : spec.default);
      else if (spec.type === "select") uniform.value = Math.max(0, spec.options.findIndex((option) => option.value === value));
      else if (spec.type === "boolean") uniform.value = value ? 1 : 0;
      else uniform.value = typeof value === "number" ? value : 0;
    }
    const variant = uniforms[`u${slot}_hasVariant`];
    if (variant) variant.value = look.hasVariant && look.meta.variant && this.host.variantReady(look.meta.variant) ? 1 : 0;
  }

  private material(from: Active | null, to: Active, type: LookTransition | null) {
    const key = `${from?.meta?.id ?? "-"}>${to.meta?.id ?? "color"}:${type ?? "none"}`;
    let material = this.materials.get(key);
    if (material) return material;
    const uniforms: Record<string, THREE.IUniform> = {
      tFrame: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, uProgress: { value: 1 },
      uRayX: { value: new THREE.Vector3() }, uRayY: { value: new THREE.Vector3() }, uRayZ: { value: new THREE.Vector3() },
      uDirection: { value: new THREE.Vector3(0, -1, 0) }, uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uFrontColor: { value: new THREE.Color() }
    };
    for (const [slot, look] of [["A", from], ["B", to]] as const) {
      if (!look?.meta) continue;
      uniforms[`u${slot}_hasVariant`] = { value: 0 };
      uniforms[`u${slot}_backdrop`] = { value: new THREE.Color(look.meta.backdrop ?? "#0a0c10") };
      for (const spec of look.meta.params) uniforms[`u${slot}_${spec.key}`] = { value: spec.type === "color" ? new THREE.Color(spec.default) : 0 };
    }
    material = new THREE.ShaderMaterial({
      uniforms, vertexShader: LOOK_VERTEX, fragmentShader: lookFragment(from?.meta ?? null, to.meta, type),
      depthTest: false, depthWrite: false
    });
    this.materials.set(key, material);
    return material;
  }

  private ensureTarget() {
    this.renderer.getDrawingBufferSize(this.size);
    const width = Math.max(1, Math.floor(this.size.x)), height = Math.max(1, Math.floor(this.size.y));
    if (this.target && this.target.width === width && this.target.height === height) return this.target;
    this.target?.dispose();
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: this.floatTargets ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: true, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter
    });
    return this.target;
  }

  /**
   * Small previews of the current view in each look, for choosing one. Looks
   * that redraw the space from another version show their drawn-by-shader form.
   */
  thumbnails(scene: THREE.Scene, camera: THREE.PerspectiveCamera, ids: string[], width = 240): Record<string, string> {
    const aspect = camera.aspect;
    const height = Math.round(width / aspect);
    const frame = new THREE.WebGLRenderTarget(width * 2, height * 2, { type: this.floatTargets ? THREE.HalfFloatType : THREE.UnsignedByteType });
    const output = new THREE.WebGLRenderTarget(width, height);
    const pixels = new Uint8Array(width * height * 4);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(width, height);
    const result: Record<string, string> = {};
    try {
      this.host.setLinearOutput(true);
      this.renderer.setRenderTarget(frame);
      this.renderer.render(scene, camera);
      this.renderer.setRenderTarget(null);
      this.host.setLinearOutput(false);
      for (const id of ids) {
        const meta = id === "color" ? null : lookEntry(id);
        if (id !== "color" && !meta) continue;
        this.draw(frame.texture, camera, 0, output, { meta, params: meta ? resolveParams(meta, {}) : {}, hasVariant: false, key: id });
        this.renderer.readRenderTargetPixels(output, 0, 0, width, height, pixels);
        // Rows come bottom first.
        for (let row = 0; row < height; row += 1) image.data.set(pixels.subarray((height - 1 - row) * width * 4, (height - row) * width * 4), row * width * 4);
        context.putImageData(image, 0, 0);
        result[id] = canvas.toDataURL("image/jpeg", 0.8);
      }
    } finally {
      this.host.setLinearOutput(false);
      this.renderer.setRenderTarget(null);
      frame.dispose();
      output.dispose();
    }
    return result;
  }

  dispose() {
    this.target?.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.quad.geometry.dispose();
  }
}
