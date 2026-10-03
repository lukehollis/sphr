import core from "@/lib/experience/core/pack";
import extraPacks from "@/lib/experience/extra-packs";
import type { EffectEntry, Pack, ShapeEntry } from "@/lib/experience/registry";

/** Every installed pack, core first. Deployments add theirs in extra-packs.ts. */
export const packs: Pack[] = [core, ...extraPacks];

const effects = new Map<string, EffectEntry>();
const shapes = new Map<string, ShapeEntry>();
for (const pack of packs) {
  for (const effect of pack.effects) if (!effects.has(effect.type)) effects.set(effect.type, effect);
  for (const shape of pack.shapes) if (!shapes.has(shape.shape)) shapes.set(shape.shape, shape);
}

export function effectEntry(type: string) { return effects.get(type) ?? null; }
export function shapeEntry(shape: string) { return shapes.get(shape) ?? null; }
export function effectEntries() { return [...effects.values()]; }
export function shapeEntries() { return [...shapes.values()]; }
