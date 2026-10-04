import core from "@/lib/experience/core/pack";
import extraPacks from "@/lib/experience/extra-packs";
import type { EffectEntry, LookEntry, Pack, ShapeEntry, SkyEntry, SoundEntry } from "@/lib/experience/registry";

/** Every installed pack, core first. Deployments add theirs in extra-packs.ts. */
export const packs: Pack[] = [core, ...extraPacks];

const effects = new Map<string, EffectEntry>();
const shapes = new Map<string, ShapeEntry>();
const sounds = new Map<string, SoundEntry>();
const looks = new Map<string, LookEntry>();
const skies = new Map<string, SkyEntry>();
for (const pack of packs) {
  for (const sky of pack.skies ?? []) if (!skies.has(sky.id)) skies.set(sky.id, sky);
  for (const look of pack.looks ?? []) if (!looks.has(look.id)) looks.set(look.id, look);
  for (const sound of pack.sounds ?? []) if (!sounds.has(sound.id)) sounds.set(sound.id, sound);
  for (const effect of pack.effects) if (!effects.has(effect.type)) effects.set(effect.type, effect);
  for (const shape of pack.shapes) if (!shapes.has(shape.shape)) shapes.set(shape.shape, shape);
}

export function effectEntry(type: string) { return effects.get(type) ?? null; }
export function shapeEntry(shape: string) { return shapes.get(shape) ?? null; }
export function effectEntries() { return [...effects.values()]; }
export function shapeEntries() { return [...shapes.values()]; }
export function soundEntry(id: string) { return sounds.get(id) ?? null; }
export function soundEntries() { return [...sounds.values()]; }
export function lookEntry(id: string) { return looks.get(id) ?? null; }
export function lookEntries() { return [...looks.values()]; }
export function skyEntry(id: string) { return skies.get(id) ?? null; }
export function skyEntries() { return [...skies.values()]; }
