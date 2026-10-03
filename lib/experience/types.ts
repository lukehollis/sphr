import type { CameraRotation, MediaFile, Vector3Like } from "@/lib/types";

export type Vec3 = [number, number, number];

/** Where a placed object's geometry comes from: a pack shape, a glTF model, or an image card. */
export type ObjectSource =
  | { kind: "shape"; shape: string; color?: string; text?: string }
  | { kind: "model"; url: string }
  | { kind: "image"; url: string };

export type ObjectIdle = "none" | "spin" | "bob" | "float";

export type PlacedObject = {
  id: string;
  name: string;
  source: ObjectSource;
  position: Vec3;
  /** Euler angles in degrees, XYZ order. */
  rotation: Vec3;
  scale: Vec3;
  /** Shown everywhere, free exploration included. Otherwise only at the stops that list it. */
  always?: boolean;
  idle?: ObjectIdle;
  /** Short text shown when the pointer rests on the object. */
  label?: string;
};

export type EffectTarget =
  | { kind: "scene" }
  | { kind: "object"; id: string }
  | { kind: "point"; position: Vec3 };

export type EffectParams = Record<string, number | string | boolean>;

export type EffectInstance = {
  id: string;
  type: string;
  name?: string;
  target: EffectTarget;
  params: EffectParams;
  /** Runs in free exploration and at every stop. Otherwise only at the stops that list it. */
  always?: boolean;
};

export type StopView = {
  nodeId?: string;
  position?: Vector3Like;
  rotation: CameraRotation;
  fov?: number;
  viewMode?: "FPV" | "ORBIT";
};

/** A scavenger hunt step asks the visitor to find one placed object. */
export type StopFind = { objectId: string; hint?: string; found?: string };

/** How one look gives way to the next, like a cut in a video editor. */
export type LookTransition = "cut" | "fade" | "dissolve" | "wipe" | "iris" | "sweep" | "glitch";
export const LOOK_TRANSITIONS: readonly LookTransition[] = ["cut", "fade", "dissolve", "wipe", "iris", "sweep", "glitch"];

/**
 * A visual style for the whole frame (a line drawing, a blueprint, film noir…),
 * set for the tour and changed per stop. `color` is the capture as it is.
 */
export type StopLook = {
  look: string;
  params?: EffectParams;
  transition?: LookTransition;
  /** Seconds the transition takes. */
  duration?: number;
};

export type ExperienceStop = {
  id: string;
  title: string;
  /** Narration for a tour, or the clue for a hunt. Plain text; blank lines separate paragraphs. */
  text: string;
  detail?: string;
  view: StopView;
  objects: string[];
  effects: string[];
  find?: StopFind;
  /** Media and narration carried over from an earlier authored stop. */
  files?: MediaFile[];
  sounds?: string[];
  models?: string[];
  annotations?: string[];
  /** This stop's look; without one, the tour's look. */
  look?: StopLook;
};

export type ExperienceKind = "tour" | "hunt";

export type Experience = {
  version: 1;
  kind: ExperienceKind;
  title?: string;
  /** Shown after the last stop of a tour or when every hunt item is found. */
  finale?: string;
  stops: ExperienceStop[];
  objects: PlacedObject[];
  effects: EffectInstance[];
  /** The look for free exploration and for stops without their own. */
  look?: StopLook;
};

export const EXPERIENCE_LIMITS = {
  stops: 60,
  objects: 200,
  effects: 120,
  text: 4000,
  title: 200,
  name: 120,
  url: 2048,
  coordinate: 1e6
} as const;

export function emptyExperience(kind: ExperienceKind = "tour"): Experience {
  return { version: 1, kind, stops: [], objects: [], effects: [] };
}

export function newId(prefix: string, taken: Iterable<string> = []) {
  const used = new Set(taken);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}-${Date.now().toString(36)}`;
}

/** Paragraphs of a plain stop text, separated by blank lines. */
export function paragraphs(text?: string | null) {
  return (text ?? "").split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
}

/** Strip authored HTML from an older tour stop into editable plain text. */
export function htmlToPlainText(html?: string | null) {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote)\s*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
