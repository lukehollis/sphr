import type * as THREE from "three";
import type { dyno as SparkDynoNamespace } from "@sparkjsdev/spark";
import type { EffectInstance, EffectParams, PlacedObject } from "./types";
import type { PanoramaStyle } from "@/lib/three/renderers/PanoramaLayer";

/**
 * Effects and shapes come in packs. A pack lists plain metadata, which the
 * editor, the validator and the tour agent read on the server, and loads its
 * Three.js code lazily in the browser only when a space uses it.
 */

export type ParamSpec =
  | { key: string; label: string; type: "number"; min: number; max: number; step?: number; default: number }
  | { key: string; label: string; type: "color"; default: string }
  | { key: string; label: string; type: "boolean"; default: boolean }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[]; default: string }
  /** A sound from the installed packs (by ID) or an audio file address. */
  | { key: string; label: string; type: "sound"; kinds: SoundKind[]; default: string };

export type SoundKind = "sfx" | "ambient" | "music";

export type SoundMeta = {
  id: string;
  label: string;
  kind: SoundKind;
  /** One sentence for the editor and the tour agent. */
  description: string;
};

/** Renders a sound into a buffer: synthesized, or decoded from a hosted file. */
export type SoundRenderer = (sampleRate: number) => Promise<AudioBuffer>;
export type SoundEntry = SoundMeta & { load: () => Promise<{ default: SoundRenderer }> };

export type EffectTargetKind = "scene" | "object" | "point";

export type EffectMeta = {
  type: string;
  label: string;
  /** One sentence for the editor and the tour agent. */
  description: string;
  targets: EffectTargetKind[];
  params: ParamSpec[];
  /** Plays once when a scavenger hunt item is found or a hint is asked for. */
  oneShot?: boolean;
  /** Only works in Gaussian splat spaces, because it rewrites the splats themselves. */
  requires?: "splats";
};

export type ShapeMeta = {
  shape: string;
  label: string;
  description: string;
  color: string;
  /** Approximate height in meters at scale 1, so agents can size placements. */
  size: number;
  /** The shape draws the object's text (signs, labels). */
  text?: boolean;
};

/** Pointer contact with the space's surfaces or with a placed object. */
export type PointerHit = {
  point: THREE.Vector3;
  normal: THREE.Vector3 | null;
  objectId: string | null;
};

export type FrameInfo = { time: number; delta: number; camera: THREE.PerspectiveCamera };

/** Spark's dyno namespace, passed in so effect code never imports Spark itself. */
export type SparkDyno = typeof SparkDynoNamespace;
export type GsplatValue = SparkDynoNamespace.DynoVal<typeof SparkDynoNamespace.Gsplat>;
/** Rewrites each splat on the GPU, in world space, every time splats regenerate. */
export type SplatModifier = (dyno: SparkDyno, gsplat: GsplatValue) => GsplatValue;

export type SplatHost = {
  /**
   * Adds a per-splat modifier to the space's color splats, or to its companion
   * line-drawing splats with role "sketch"; returns its removal.
   */
  addModifier(modifier: SplatModifier, role?: "color" | "sketch"): () => void;
  /** Whether the space has a companion splat trained on line drawings. */
  hasSketch: boolean;
  /** Show or hide the companion line-drawing splats. */
  showSketch(visible: boolean): void;
  /** Regenerate splats this frame because a modifier's uniforms changed. */
  invalidate(): void;
  dyno: SparkDyno;
};

export type EffectContext = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** The placed object this effect targets, if any. It follows editor moves. */
  object(): THREE.Object3D | null;
  /** World anchor of the target: its point, the object's center, or the space's center. */
  anchor(out: THREE.Vector3): THREE.Vector3;
  /** Bounds of the target object, or of the whole space. */
  bounds(out: THREE.Box3): THREE.Box3;
  spaceBounds(out: THREE.Box3): THREE.Box3;
  /** Meshes of the captured space, for surface overlays and raycasts. */
  surfaces(): THREE.Mesh[];
  /** Present only in Gaussian splat spaces. */
  splats: SplatHost | null;
  /** Shared uniforms that restyle the 360 photographs, in panorama spaces. */
  panorama: PanoramaStyle | null;
  /** First person at a panorama, or the overview (dollhouse). */
  viewMode(): "FPV" | "ORBIT";
  /** Sound for effects that play audio; created on first use. */
  audio(): AudioHost;
  reducedMotion: boolean;
};

export type EffectHandle = {
  update(frame: FrameInfo): void;
  /** Fade in or out as stops change. */
  setActive(active: boolean): void;
  /** One-shot cues: a hunt item found, a hint asked for, a click on the target. */
  play?(cue: "found" | "hint" | "click"): void;
  pointer?(hit: PointerHit | null): void;
  setParams?(params: EffectParams): void;
  dispose(): void;
};

export type EffectFactory = (context: EffectContext, instance: EffectInstance) => EffectHandle;

export type ShapeFactory = (object: PlacedObject) => THREE.Object3D;

export type EffectEntry = EffectMeta & { load: () => Promise<{ default: EffectFactory }> };
export type ShapeEntry = ShapeMeta & { load: () => Promise<{ default: ShapeFactory }> };

export type Pack = {
  id: string;
  label: string;
  effects: EffectEntry[];
  shapes: ShapeEntry[];
  sounds?: SoundEntry[];
};

/** Audio shared by every effect: one context, a listener on the camera and a master volume. */
export type AudioHost = {
  context: AudioContext;
  listener: THREE.AudioListener;
  /** A library sound by ID, or a file address, decoded and cached. */
  buffer(source: string): Promise<AudioBuffer | null>;
  /** True once the browser lets audio play (after the visitor's first touch or key). */
  unlocked(): boolean;
};

/** Fill in defaults and clamp a params object against an effect's specs. */
export function resolveParams(meta: Pick<EffectMeta, "params">, input: unknown): EffectParams {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const output: EffectParams = {};
  for (const spec of meta.params) {
    const value = source[spec.key];
    if (spec.type === "number") {
      const number = typeof value === "number" && Number.isFinite(value) ? value : spec.default;
      output[spec.key] = Math.min(spec.max, Math.max(spec.min, number));
    } else if (spec.type === "color") {
      output[spec.key] = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : spec.default;
    } else if (spec.type === "boolean") {
      output[spec.key] = typeof value === "boolean" ? value : spec.default;
    } else if (spec.type === "sound") {
      const ok = typeof value === "string" && (/^[a-z0-9][a-z0-9-]{0,63}$/.test(value) || /^https:\/\/[^\s]{1,2000}$/.test(value) || /^\/(?!\/)[^\s]{1,500}$/.test(value));
      output[spec.key] = ok ? value as string : spec.default;
    } else {
      output[spec.key] = typeof value === "string" && spec.options.some((option) => option.value === value) ? value : spec.default;
    }
  }
  return output;
}

export function num(params: EffectParams, key: string, fallback = 0) {
  const value = params[key];
  return typeof value === "number" ? value : fallback;
}

export function str(params: EffectParams, key: string, fallback = "") {
  const value = params[key];
  return typeof value === "string" ? value : fallback;
}

export function bool(params: EffectParams, key: string, fallback = false) {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}
