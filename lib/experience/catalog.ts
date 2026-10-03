import { effectEntries, lookEntries, shapeEntries, soundEntries } from "@/lib/experience/packs";
import type { ParamSpec } from "@/lib/experience/registry";
import { LOOK_TRANSITIONS } from "@/lib/experience/types";

/** A param in a few words, for agents: its range, choices or kind, and its default. */
export function paramSummary(param: ParamSpec) {
  switch (param.type) {
    case "number": return `${param.key} ${param.min}..${param.max} default ${param.default}`;
    case "select": return `${param.key} one of ${param.options.map((option) => option.value).join("|")} default ${param.default}`;
    case "sound": return `${param.key} a ${param.kinds.join(" or ")} sound ID or audio address, default ${param.default}`;
    default: return `${param.key} ${param.type} default ${param.default}`;
  }
}

/**
 * Everything an experience can use on this site, as plain data for agents that
 * edit tours by hand: looks and transitions, effects (retired ones left out),
 * sounds and shapes.
 */
export function experienceCatalog() {
  return {
    transitions: [...LOOK_TRANSITIONS],
    looks: lookEntries().map((entry) => ({ id: entry.id, label: entry.label, description: entry.description,
      ...(entry.requires ? { requires: entry.requires } : {}), params: entry.params.map(paramSummary) })),
    effects: effectEntries().filter((entry) => !entry.retired).map((entry) => ({ type: entry.type, label: entry.label, description: entry.description,
      targets: entry.targets, ...(entry.requires ? { requires: entry.requires } : {}), params: entry.params.map(paramSummary) })),
    sounds: soundEntries().map((entry) => ({ id: entry.id, kind: entry.kind, label: entry.label })),
    shapes: shapeEntries().map((entry) => ({ shape: entry.shape, description: entry.description, size: entry.size }))
  };
}
