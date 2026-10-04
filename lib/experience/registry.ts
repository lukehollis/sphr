import type * as THREE from "three";
import type { dyno as SparkDynoNamespace } from "@sparkjsdev/spark";
import type { EffectInstance, EffectParams, PlacedObject } from "./types";
import type { PanoramaStyle } from "@/lib/three/renderers/PanoramaLayer";

/**
 * Effects and shapes come in packs. A pack lists plain metadata, which the
 * editor, the validator and the tour agent read on the server, and loads its
 * Three.js code lazily in the browser only when a space uses it.
 */

export type ParamSpec = (
  | { key: string; label: string; type: "number"; min: number; max: number; step?: number; default: number }
  | { key: string; label: string; type: "color"; default: string }
  | { key: string; label: string; type: "boolean"; default: boolean }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[]; default: string }
  /** A sound from the installed packs (by ID) or an audio file address. */
  | { key: string; label: string; type: "sound"; kinds: SoundKind[]; default: string }
) & {
  /** A few words for agents on what the choices do, when the values alone do not say. */
  about?: string;
};

/** What a visitor does to a placed object that effects can answer. */
export type EffectCue = "found" | "hint" | "click";
export const EFFECT_CUES: readonly EffectCue[] = ["found", "hint", "click"];

/**
 * When a visual effect that answers cues plays. With its stop (the default) it runs
 * while a stop that lists it is open and also answers a find, a hint or a click on its
 * object. Set to a cue, it holds back until that cue alone, so listing it on a stop only
 * arms it: a celebration for a hunt find gives nothing away before the find.
 */
export const CUE_TRIGGER: ParamSpec = {
  key: "trigger", label: "Plays", type: "select", default: "stop",
  options: [
    { value: "stop", label: "With its stop" },
    { value: "found", label: "Only when the hunt item is found" },
    { value: "hint", label: "Only when a hint is asked for" },
    { value: "click", label: "Only when its object is clicked" }
  ],
  about: "stop runs with its stop and also answers a find, hint or click on its object; found, hint or click holds it back until that moment alone"
};

/** The cue an effect holds back for (its `trigger`), or null when it plays with its stop. */
export function waitsForCue(params: EffectParams): EffectCue | null {
  const trigger = params.trigger;
  return typeof trigger === "string" && (EFFECT_CUES as readonly string[]).includes(trigger) ? trigger as EffectCue : null;
}

/**
 * Whether an effect aimed at an object answers a cue on it: one that plays with its
 * stop answers every cue, one with a trigger only the cue it names (a sound that plays
 * when its stop opens or on repeat answers none).
 */
export function answersCue(params: EffectParams, cue: EffectCue) {
  const trigger = params.trigger;
  return trigger === undefined || trigger === "stop" || trigger === cue;
}

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
  /** Kept working for tours that use it, but not offered for new ones. */
  retired?: string;
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
  /** Fade in or out as stops change. An effect holding back for a cue is never made active. */
  setActive(active: boolean): void;
  /**
   * One-shot cues: a hunt item found, a hint asked for, a click on the target. It may
   * come while the effect is not active, so it shows on its own and ends by itself.
   * Return false when this cue shows nothing, so the viewer can show its own.
   */
  play?(cue: EffectCue): boolean | void;
  pointer?(hit: PointerHit | null): void;
  setParams?(params: EffectParams): void;
  dispose(): void;
};

export type EffectFactory = (context: EffectContext, instance: EffectInstance) => EffectHandle;

export type ShapeFactory = (object: PlacedObject) => THREE.Object3D;

export type EffectEntry = EffectMeta & { load: () => Promise<{ default: EffectFactory }> };
export type ShapeEntry = ShapeMeta & { load: () => Promise<{ default: ShapeFactory }> };

/**
 * A look restyles the whole rendered frame in one full-screen shader. `glsl` is
 * the body of `vec3 look(vec2 uv)`, returning a display (sRGB) color. It can call
 * SAMPLE(uv) for the frame's sRGB color, LUM(c), EDGES(uv, width) for a 0..1 edge
 * strength, BLUR(uv, radius), HASH(p), NOISE(p) and P(key) for a parameter, and
 * COVER(uv) for how much of the pixel the space covers (splats leave gaps), and
 * read uTime, uResolution and PX (one pixel in uv units). A look with a `variant`
 * renders that version of the space first when one exists (a companion splat
 * trained on line drawings, or line-drawn panorama photos); HAS_VARIANT says
 * whether it did, so the shader can fall back to drawing lines itself.
 */
export type LookMeta = {
  id: string;
  label: string;
  /** One sentence for the editor and the tour agent. */
  description: string;
  params: ParamSpec[];
  variant?: "sketch" | "watercolor";
  /** Shrink or flatten the splats while the look is on. */
  splats?: { scale?: number; opacity?: number; falloff?: number };
  /** Only works in Gaussian splat spaces. */
  requires?: "splats";
  /** Color behind the space where it leaves gaps (splats rarely fill the frame); paper for drawings. */
  backdrop?: string;
  glsl: string;
};
export type LookEntry = LookMeta;

export type SkyKind = "day" | "cloudy" | "storm" | "sunrise" | "sunset" | "dusk" | "night";

/** A sky drawn in the shader from colors alone, for packs that ship no images. */
export type SkyGradient = {
  zenith: string;
  horizon: string;
  /** The haze below the horizon. */
  ground: string;
  /** A sun or moon disc where the sky's `sun` says. */
  sun?: { color: string; size: number };
  /** How many stars show, 0 to 1. */
  stars?: number;
};

/**
 * A sky to put behind a space: an equirectangular photograph (`image`, with a
 * small `preview` that loads first) or a `gradient` drawn in the shader. `light` is
 * the color the space is multiplied by under it, and `sun` is where its sun or
 * moon is in the image, for lighting placed objects.
 */
export type SkyMeta = {
  id: string;
  label: string;
  kind: SkyKind;
  /** One sentence for the editor and the tour agent. */
  description: string;
  /** Where it was photographed. */
  place?: string;
  image?: string;
  preview?: string;
  thumb?: string;
  gradient?: SkyGradient;
  light: string;
  sun?: [number, number];
  credit?: string;
  source?: string;
};
export type SkyEntry = SkyMeta;

/**
 * Where a sky's sun or moon is, as a stop's heading (azimuth, degrees) and height above
 * the horizon, before the sky is turned; turning a sky by T moves it to heading + T.
 */
export function skySunHeading(sky: Pick<SkyMeta, "sun">) {
  if (!sky.sun) return null;
  const heading = ((-(sky.sun[0] - 0.5) * 360 - 90) % 360 + 540) % 360 - 180;
  return { heading: Math.round(heading), height: Math.round((0.5 - sky.sun[1]) * 180) };
}

/** The turn that puts a sky's sun or moon at a heading, from -180 to 180. */
export function skyTurnToward(sky: Pick<SkyMeta, "sun">, heading: number) {
  const sun = skySunHeading(sky);
  return sun ? Math.round(((heading - sun.heading) % 360 + 540) % 360 - 180) : 0;
}

export type Pack = {
  id: string;
  label: string;
  effects: EffectEntry[];
  shapes: ShapeEntry[];
  sounds?: SoundEntry[];
  looks?: LookEntry[];
  skies?: SkyEntry[];
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
