import { effectEntry, lookEntry, shapeEntry, skyEntry } from "@/lib/experience/packs";
import { resolveParams } from "@/lib/experience/registry";
import {
  EARTH_RANGE,
  EXPERIENCE_LIMITS as LIMITS,
  LOOK_TRANSITIONS,
  type EarthPlace,
  type EffectInstance,
  type EffectTarget,
  type Experience,
  type ExperienceStop,
  type ObjectSource,
  type PlacedObject,
  type LookTransition,
  type StopLook,
  type StopSky,
  SKY_RANGES,
  type StopView,
  type Vec3
} from "@/lib/experience/types";
import type { MediaFile } from "@/lib/types";

export class ExperienceError extends Error {}

type Options = {
  /** Panorama node IDs in the space. Stops must stand on one when the space has panoramas. */
  nodeIds?: Set<string>;
  /** Drop unknown effects and shapes instead of rejecting them (for older saved tours). */
  lenient?: boolean;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function fail(message: string): never { throw new ExperienceError(message); }

function text(value: unknown, limit: number, label: string, required = false) {
  if (value === undefined || value === null) {
    if (required) fail(`${label} is missing.`);
    return "";
  }
  if (typeof value !== "string") fail(`${label} must be text.`);
  const clean = value.replace(CONTROL, "").replace(/\r\n?/g, "\n");
  if (clean.length > limit) fail(`${label} is longer than ${limit} characters.`);
  return clean;
}

function finite(value: unknown, label: string, limit: number = LIMITS.coordinate) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit) fail(`${label} must be a number.`);
  return value;
}

function vec3(value: unknown, label: string, limit?: number): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) fail(`${label} needs three numbers.`);
  return [finite(value[0], label, limit), finite(value[1], label, limit), finite(value[2], label, limit)];
}

function id(value: unknown, label: string) {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} needs a short ID of letters, numbers, dashes or underscores.`);
  return value;
}

/** Models and images load from https, or from this site. */
export function safeAssetUrl(value: unknown, label: string) {
  const url = text(value, LIMITS.url, label, true).trim();
  if (/^\/(?!\/)[^\s]*$/.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) return parsed.toString();
  } catch { /* fall through */ }
  fail(`${label} must be an https address.`);
}

function source(value: unknown, label: string, lenient: boolean): ObjectSource | null {
  const input = value as Record<string, unknown> | null;
  if (!input || typeof input !== "object") fail(`${label} needs a source.`);
  if (input.kind === "model" || input.kind === "image") {
    // An agent may name a model that is not in the library; its draft keeps everything else.
    try { return { kind: input.kind, url: safeAssetUrl(input.url, `${label} ${input.kind}`) }; }
    catch (error) { if (lenient) return null; throw error; }
  }
  if (input.kind === "shape") {
    const shape = typeof input.shape === "string" ? input.shape : "";
    if (!shapeEntry(shape)) {
      if (lenient) return null;
      fail(`${label} uses an unknown shape.`);
    }
    const color = typeof input.color === "string" && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color.toLowerCase() : undefined;
    const caption = text(input.text, 300, `${label} text`);
    return { kind: "shape", shape, ...(color ? { color } : {}), ...(caption ? { text: caption } : {}) };
  }
  fail(`${label} has an unknown source.`);
}

function placedObject(value: unknown, index: number, lenient: boolean): PlacedObject | null {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object") fail(`Object ${index + 1} is invalid.`);
  const label = `Object ${index + 1}`;
  const from = source(input.source, label, lenient);
  if (!from) return null;
  const scaleInput = typeof input.scale === "number" ? [input.scale, input.scale, input.scale] : input.scale ?? [1, 1, 1];
  const scale = vec3(scaleInput, `${label} scale`, 1000);
  if (scale.some((value) => Math.abs(value) < 1e-4)) fail(`${label} scale is too small.`);
  const idle = input.idle === "spin" || input.idle === "bob" || input.idle === "float" ? input.idle : "none";
  const name = text(input.name, LIMITS.name, `${label} name`).trim() || `Object ${index + 1}`;
  const hover = text(input.label, 300, `${label} label`).trim();
  const animation = typeof input.animation === "string" ? input.animation.trim().slice(0, 60) : "";
  let link = "";
  if (input.link !== undefined && input.link !== null && input.link !== "") {
    try { link = safeAssetUrl(input.link, `${label} link`); }
    catch (error) { if (!lenient) throw error; }
  }
  return {
    id: id(input.id, label),
    name,
    source: from,
    position: vec3(input.position ?? [0, 0, 0], `${label} position`),
    rotation: vec3(input.rotation ?? [0, 0, 0], `${label} rotation`, 36000),
    scale,
    ...(input.always === true ? { always: true } : {}),
    ...(idle !== "none" ? { idle } : {}),
    ...(animation ? { animation } : {}),
    ...(hover ? { label: hover } : {}),
    ...(link ? { link } : {})
  };
}

function effectTarget(value: unknown, objects: Set<string>, label: string): EffectTarget {
  const input = value as Record<string, unknown> | undefined;
  if (!input || input.kind === "scene") return { kind: "scene" };
  if (input.kind === "object") {
    const target = id(input.id, `${label} target`);
    if (!objects.has(target)) fail(`${label} targets an object that is not in the tour.`);
    return { kind: "object", id: target };
  }
  if (input.kind === "point") return { kind: "point", position: vec3(input.position, `${label} point`) };
  fail(`${label} has an unknown target.`);
}

function effect(value: unknown, index: number, objects: Set<string>, lenient: boolean): EffectInstance | null {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object") fail(`Effect ${index + 1} is invalid.`);
  const label = `Effect ${index + 1}`;
  const type = typeof input.type === "string" ? input.type : "";
  const entry = effectEntry(type);
  if (!entry) {
    if (lenient) return null;
    fail(`${label} uses an effect this site does not have.`);
  }
  let target: EffectTarget;
  try { target = effectTarget(input.target, objects, label); }
  catch (error) { if (lenient) return null; throw error; }
  if (!entry.targets.includes(target.kind)) {
    if (lenient) return null;
    fail(`${entry.label} cannot target ${target.kind === "scene" ? "the whole space" : `a ${target.kind}`}.`);
  }
  const name = text(input.name, LIMITS.name, `${label} name`).trim();
  return {
    id: id(input.id, label),
    type,
    ...(name ? { name } : {}),
    target,
    params: resolveParams(entry, input.params),
    ...(input.always === true ? { always: true } : {})
  };
}

function view(value: unknown, label: string, nodeIds?: Set<string>): StopView {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object") fail(`${label} needs a camera view.`);
  const rotation = input.rotation as Record<string, unknown> | undefined;
  const result: StopView = {
    rotation: { azimuth: finite(rotation?.azimuth ?? 0, `${label} heading`, 36000), polar: Math.max(-89.9, Math.min(89.9, finite(rotation?.polar ?? 0, `${label} tilt`, 90))) }
  };
  if (input.nodeId !== undefined && input.nodeId !== null && input.nodeId !== "") {
    if (typeof input.nodeId !== "string" || input.nodeId.length > 128) fail(`${label} has an invalid location.`);
    if (nodeIds && !nodeIds.has(input.nodeId)) fail(`${label} stands on a location that is no longer in this space.`);
    result.nodeId = input.nodeId;
  }
  if (input.position) {
    const position = input.position as Record<string, unknown>;
    result.position = { x: finite(position.x, `${label} position`), y: finite(position.y, `${label} position`), z: finite(position.z, `${label} position`) };
  }
  if (nodeIds?.size && !result.nodeId) fail(`${label} needs a location in the space.`);
  if (input.fov !== undefined) result.fov = Math.max(30, Math.min(110, finite(input.fov, `${label} zoom`, 180)));
  if (input.viewMode === "ORBIT") result.viewMode = "ORBIT";
  if (typeof input.reconstruction === "boolean") result.reconstruction = input.reconstruction;
  if (typeof input.reconstructionVariant === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(input.reconstructionVariant)) result.reconstructionVariant = input.reconstructionVariant;
  if (input.distance !== undefined) result.distance = Math.max(.1, Math.min(5000000, finite(input.distance, `${label} orbit distance`)));
  const earth = input.earth as Record<string, unknown> | undefined;
  if (earth && typeof earth === "object") {
    const range = finite(earth.range ?? EARTH_RANGE.default, `${label} height above the map`);
    result.earth = { range: Math.round(Math.max(EARTH_RANGE.min, Math.min(EARTH_RANGE.max, range))) };
  }
  return result;
}

/** The space's spot on the 3D map; a bad one is dropped from older tours, or refused when strict. */
function place(value: unknown, options: Options): EarthPlace | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const input = value as Record<string, unknown>;
    if (typeof input !== "object") fail("The map location is invalid.");
    const result: EarthPlace = {
      lat: finite(input.lat, "Latitude", 90),
      lon: finite(input.lon, "Longitude", 180),
      heading: Math.round((((finite(input.heading ?? 0, "Map heading", 36000) % 360) + 360) % 360) * 100) / 100
    };
    if (input.nodeId !== undefined && input.nodeId !== null && input.nodeId !== "") {
      if (typeof input.nodeId !== "string" || input.nodeId.length > 128) fail("The map location has an invalid panorama.");
      if (options.nodeIds && !options.nodeIds.has(input.nodeId)) fail("The map location stands on a panorama that is no longer in this space.");
      result.nodeId = input.nodeId;
    }
    if (input.elevation !== undefined) result.elevation = Math.round(finite(input.elevation, "Map height", 2000) * 100) / 100;
    if (input.scale !== undefined) {
      const scale = finite(input.scale, "Map scale", 1000);
      if (scale < 0.001) fail("Map scale is too small.");
      if (scale !== 1) result.scale = scale;
    }
    return result;
  } catch (error) {
    if (options.lenient) return undefined;
    throw error;
  }
}

function strings(value: unknown, allowed: Set<string> | null, limit = 200) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= limit && (!allowed || allowed.has(item))))];
}

function files(value: unknown): MediaFile[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const safe = value.slice(0, 12).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const file: MediaFile = {};
    for (const key of ["filename", "url", "file", "image", "video", "mime_type", "mimeType", "title", "caption"] as const) {
      const entry = (item as Record<string, unknown>)[key];
      if (typeof entry === "string" && entry.length <= LIMITS.url) file[key] = entry;
    }
    return Object.keys(file).length ? [file] : [];
  });
  return safe.length ? safe : undefined;
}

/** A look by ID with clamped parameters; an unknown look is dropped, or refused when strict. */
function look(value: unknown, label: string, lenient: boolean): StopLook | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const input = (typeof value === "string" ? { look: value } : value) as Record<string, unknown>;
  if (!input || typeof input !== "object" || typeof input.look !== "string") { if (lenient) return undefined; fail(`${label} has an invalid look.`); }
  const entry = input.look === "color" ? null : lookEntry(input.look as string);
  if (input.look !== "color" && !entry) { if (lenient) return undefined; fail(`${label} uses a look this site does not have: ${String(input.look).slice(0, 40)}.`); }
  const result: StopLook = { look: input.look as string };
  if (entry?.params.length) result.params = resolveParams(entry, input.params);
  if (typeof input.transition === "string" && (LOOK_TRANSITIONS as readonly string[]).includes(input.transition)) result.transition = input.transition as LookTransition;
  if (typeof input.duration === "number" && Number.isFinite(input.duration)) result.duration = Math.round(Math.max(0, Math.min(8, input.duration)) * 100) / 100;
  return result;
}

/**
 * A sky by ID, `custom` with an image address, or `none`; an unknown sky is dropped,
 * or refused when strict. A bare address is taken as a custom sky.
 */
export function sky(value: unknown, label: string, lenient: boolean): StopSky | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const bare = typeof value === "string";
  const input = (bare ? (/^(https:\/\/|\/)/.test(value) ? { sky: "custom", url: value } : { sky: value }) : value) as Record<string, unknown>;
  if (!input || typeof input !== "object" || typeof input.sky !== "string") { if (lenient) return undefined; fail(`${label} has an invalid sky.`); }
  const name = input.sky as string;
  const result: StopSky = { sky: name };
  if (name === "custom") {
    try { result.url = safeAssetUrl(input.url, `${label} sky image`); }
    catch (error) { if (lenient) return undefined; throw error; }
  } else if (name !== "none" && !skyEntry(name)) {
    if (lenient) return undefined;
    fail(`${label} uses a sky this site does not have: ${name.slice(0, 40)}.`);
  }
  for (const key of ["turn", "brightness", "light", "duration"] as const) {
    const number = input[key];
    if (typeof number !== "number" || !Number.isFinite(number)) continue;
    const range = SKY_RANGES[key];
    const clamped = Math.max(range.min, Math.min(range.max, number));
    if (clamped !== range.default) result[key] = Math.round(clamped * 100) / 100;
  }
  return result;
}

function stop(value: unknown, index: number, objects: Set<string>, effects: Set<string>, options: Options): ExperienceStop {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object") fail(`Stop ${index + 1} is invalid.`);
  const label = `Stop ${index + 1}`;
  const result: ExperienceStop = {
    id: id(input.id, label),
    title: text(input.title, LIMITS.title, `${label} title`).trim(),
    text: text(input.text, LIMITS.text, `${label} text`).trim(),
    view: view(input.view, label, options.nodeIds),
    objects: strings(input.objects, objects),
    effects: strings(input.effects, effects)
  };
  const detail = text(input.detail, LIMITS.text, `${label} detail`).trim();
  if (detail) result.detail = detail;
  const find = input.find as Record<string, unknown> | undefined;
  if (find && typeof find === "object" && find.objectId) {
    const objectId = id(find.objectId, `${label} hidden object`);
    if (!objects.has(objectId)) {
      if (!options.lenient) fail(`${label} asks visitors to find an object that is not in the tour.`);
    } else {
      const hint = text(find.hint, 1000, `${label} hint`).trim();
      const found = text(find.found, LIMITS.text, `${label} found message`).trim();
      result.find = { objectId, ...(hint ? { hint } : {}), ...(found ? { found } : {}) };
    }
  }
  const media = files(input.files);
  if (media) result.files = media;
  const stopLook = look(input.look, label, Boolean(options.lenient));
  if (stopLook) result.look = stopLook;
  const stopSky = sky(input.sky, label, Boolean(options.lenient));
  if (stopSky) result.sky = stopSky;
  for (const key of ["sounds", "models", "annotations"] as const) {
    const list = strings(input[key], null);
    if (list.length) result[key] = list;
  }
  return result;
}

/** Validate an experience from the editor, the agent, or storage. */
export function parseExperience(value: unknown, options: Options = {}): Experience {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object") fail("The tour is missing.");
  const lenient = Boolean(options.lenient);
  const kind = input.kind === "hunt" ? "hunt" : "tour";
  const rawObjects = Array.isArray(input.objects) ? input.objects : [];
  const rawEffects = Array.isArray(input.effects) ? input.effects : [];
  const rawStops = Array.isArray(input.stops) ? input.stops : [];
  if (rawObjects.length > LIMITS.objects) fail(`A tour can hold up to ${LIMITS.objects} objects.`);
  if (rawEffects.length > LIMITS.effects) fail(`A tour can hold up to ${LIMITS.effects} effects.`);
  if (rawStops.length > LIMITS.stops) fail(`A tour can have up to ${LIMITS.stops} stops.`);

  const objects = rawObjects.map((item, index) => placedObject(item, index, lenient)).filter((item): item is PlacedObject => Boolean(item));
  const objectIds = new Set<string>();
  for (const object of objects) {
    if (objectIds.has(object.id)) fail(`Two objects share the ID ${object.id}.`);
    objectIds.add(object.id);
  }
  const effects = rawEffects.map((item, index) => effect(item, index, objectIds, lenient)).filter((item): item is EffectInstance => Boolean(item));
  const effectIds = new Set<string>();
  for (const item of effects) {
    if (effectIds.has(item.id)) fail(`Two effects share the ID ${item.id}.`);
    effectIds.add(item.id);
  }
  const stops = rawStops.map((item, index) => stop(item, index, objectIds, effectIds, options));
  const stopIds = new Set<string>();
  for (const item of stops) {
    if (stopIds.has(item.id)) fail(`Two stops share the ID ${item.id}.`);
    stopIds.add(item.id);
  }
  if (kind === "hunt" && stops.some((item) => !item.find) && !lenient) {
    const missing = stops.findIndex((item) => !item.find);
    fail(`Stop ${missing + 1} of the scavenger hunt needs something to find.`);
  }
  const title = text(input.title, LIMITS.title, "Title").trim();
  const finale = text(input.finale, LIMITS.text, "Closing message").trim();
  const tourLook = look(input.look, "The tour", lenient);
  const tourSky = sky(input.sky, "The tour", lenient);
  const map = place(input.place, options);
  return { version: 1, kind, ...(title ? { title } : {}), ...(finale ? { finale } : {}), stops, objects, effects, ...(tourLook ? { look: tourLook } : {}), ...(tourSky ? { sky: tourSky } : {}), ...(map ? { place: map } : {}) };
}
