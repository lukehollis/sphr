import { coreLooks } from "@/lib/experience/core/looks";
import { coreSkies } from "@/lib/experience/core/skies";
import type { Pack } from "@/lib/experience/registry";

/**
 * The open source pack: enough to build tours and scavenger hunts and to show
 * how a pack plugs in. Larger packs register the same way (see packs.ts).
 */
const core: Pack = {
  looks: coreLooks,
  skies: coreSkies,
  id: "core",
  label: "Core",
  effects: [
    {
      type: "sparkles",
      label: "Sparkles",
      description: "Glinting sparks that hang around an object, trail behind the pointer as visitors hover the space, or burst once when something is found.",
      targets: ["object", "point", "scene"],
      params: [
        { key: "mode", label: "Behavior", type: "select", default: "aura", options: [
          { value: "aura", label: "Around the target" },
          { value: "hover", label: "Follow the pointer" },
          { value: "burst", label: "Burst once" }
        ] },
        { key: "color", label: "Color", type: "color", default: "#f7e749" },
        { key: "color2", label: "Second color", type: "color", default: "#f3a644" },
        { key: "count", label: "Amount", type: "number", min: 8, max: 400, step: 1, default: 90 },
        { key: "size", label: "Size", type: "number", min: 0.2, max: 4, step: 0.1, default: 1 },
        { key: "radius", label: "Spread (m)", type: "number", min: 0.1, max: 6, step: 0.1, default: 0.8 }
      ],
      load: () => import("@/lib/experience/core/sparkles")
    },
    {
      type: "scan",
      label: "Radial scan",
      description: "A ring of light sweeps outward across the whole capture from the target, revealing the space behind it or pulsing over it like a laser scan.",
      targets: ["point", "object", "scene"],
      params: [
        { key: "mode", label: "Behavior", type: "select", default: "reveal", options: [
          { value: "reveal", label: "Reveal the space" },
          { value: "pulse", label: "Repeating pulse" }
        ] },
        { key: "color", label: "Color", type: "color", default: "#7fd6ff" },
        { key: "speed", label: "Speed (m/s)", type: "number", min: 0.5, max: 40, step: 0.5, default: 6 },
        { key: "width", label: "Band width (m)", type: "number", min: 0.05, max: 4, step: 0.05, default: 0.6 },
        { key: "every", label: "Repeat every (s)", type: "number", min: 1, max: 30, step: 0.5, default: 6 }
      ],
      load: () => import("@/lib/experience/core/scan")
    },
    {
      type: "sketch",
      retired: "Use the Line drawing look with a sweep transition instead.",
      label: "Sketch to color",
      description: "The space appears as a pencil drawing on paper, then a radial scan paints the real colors back in from the target, or turns color into a drawing.",
      targets: ["scene", "point", "object"],
      params: [
        { key: "mode", label: "Behavior", type: "select", default: "reveal", options: [
          { value: "reveal", label: "Draw, then paint in color" },
          { value: "sketch", label: "Stay a drawing" },
          { value: "toSketch", label: "Turn color into a drawing" }
        ] },
        { key: "speed", label: "Speed (m/s)", type: "number", min: 0.5, max: 30, step: 0.5, default: 4 },
        { key: "hold", label: "Pause as a drawing (s)", type: "number", min: 0, max: 20, step: 0.5, default: 2 },
        { key: "width", label: "Edge softness (m)", type: "number", min: 0.1, max: 4, step: 0.1, default: 0.8 },
        { key: "ink", label: "Ink", type: "color", default: "#2b2a27" },
        { key: "paper", label: "Paper", type: "color", default: "#f2efe6" }
      ],
      load: () => import("@/lib/experience/core/sketch")
    },
    {
      type: "sound",
      label: "Sound effect",
      description: "A sound that plays when a stop opens, loops while it runs, or answers a hunt find, a hint or a click; on an object or a spot it comes from that place and fades with distance.",
      targets: ["scene", "object", "point"],
      params: [
        { key: "sound", label: "Sound", type: "sound", kinds: ["sfx", "ambient"], default: "chime" },
        { key: "trigger", label: "Plays", type: "select", default: "enter", options: [
          { value: "enter", label: "When the stop opens" },
          { value: "loop", label: "On repeat while the stop runs" },
          { value: "found", label: "When the hunt item is found" },
          { value: "click", label: "When its object is clicked" },
          { value: "hint", label: "When a hint is asked for" }
        ] },
        { key: "volume", label: "Volume", type: "number", min: 0, max: 1, step: 0.05, default: 0.7 },
        { key: "range", label: "Heard within (m)", type: "number", min: 1, max: 60, step: 1, default: 6 }
      ],
      load: () => import("@/lib/experience/core/sound")
    },
    {
      type: "music",
      label: "Background music",
      description: "Music or an ambient bed for the stops that list it, or the whole visit; it fades between stops and keeps playing across stops that share it.",
      targets: ["scene"],
      params: [
        { key: "track", label: "Track", type: "sound", kinds: ["music", "ambient"], default: "calm" },
        { key: "volume", label: "Volume", type: "number", min: 0, max: 1, step: 0.05, default: 0.35 },
        { key: "fade", label: "Fade (s)", type: "number", min: 0, max: 10, step: 0.5, default: 2 }
      ],
      load: () => import("@/lib/experience/core/music")
    },
    {
      type: "dust",
      label: "Floating dust",
      description: "Slow motes of dust drifting in the air, catching the light, around the target or through the whole space.",
      targets: ["scene", "object", "point"],
      params: [
        { key: "color", label: "Color", type: "color", default: "#efe2d6" },
        { key: "count", label: "Amount", type: "number", min: 20, max: 3000, step: 10, default: 600 },
        { key: "size", label: "Size", type: "number", min: 0.2, max: 4, step: 0.1, default: 1 },
        { key: "radius", label: "Spread (m)", type: "number", min: 0.5, max: 60, step: 0.5, default: 8 },
        { key: "speed", label: "Drift", type: "number", min: 0, max: 3, step: 0.05, default: 0.4 }
      ],
      load: () => import("@/lib/experience/core/dust")
    },
    {
      type: "beacon",
      label: "Beacon",
      description: "A soft column of light with a ring pulsing on the ground, to point visitors at something, or as the hint for a hunt item.",
      targets: ["object", "point"],
      params: [
        { key: "color", label: "Color", type: "color", default: "#ffffff" },
        { key: "height", label: "Height (m)", type: "number", min: 0.5, max: 30, step: 0.5, default: 4 },
        { key: "radius", label: "Ring size (m)", type: "number", min: 0.1, max: 5, step: 0.05, default: 0.5 },
        { key: "pulse", label: "Pulse speed", type: "number", min: 0, max: 4, step: 0.1, default: 1 }
      ],
      load: () => import("@/lib/experience/core/beacon")
    }
  ],
  sounds: [
    { id: "chime", label: "Chime", kind: "sfx", description: "Two bright bell tones.", load: () => import("@/lib/experience/core/sounds").then((module) => ({ default: module.chime })) },
    { id: "sparkle", label: "Sparkle", kind: "sfx", description: "A quick rising shimmer of high notes.", load: () => import("@/lib/experience/core/sounds").then((module) => ({ default: module.sparkle })) },
    { id: "found", label: "Found it", kind: "sfx", description: "A rising three-bell reward with sparkles, for hunt finds.", load: () => import("@/lib/experience/core/sounds").then((module) => ({ default: module.found })) },
    { id: "hint", label: "Hint", kind: "sfx", description: "A soft two-note bell.", load: () => import("@/lib/experience/core/sounds").then((module) => ({ default: module.hint })) },
    { id: "pop", label: "Pop", kind: "sfx", description: "A short bubbly pop.", load: () => import("@/lib/experience/core/sounds").then((module) => ({ default: module.pop })) },
    { id: "whoosh", label: "Whoosh", kind: "sfx", description: "A rush of air, for reveals and scans.", load: () => import("@/lib/experience/core/sounds").then((module) => ({ default: module.whoosh })) },
    { id: "click", label: "Click", kind: "sfx", description: "A tiny interface click.", load: () => import("@/lib/experience/core/sounds").then((module) => ({ default: module.click })) },
    { id: "air", label: "Room tone", kind: "ambient", description: "A quiet breathing room tone.", load: () => import("@/lib/experience/core/sounds").then((module) => ({ default: module.air })) },
    { id: "calm", label: "Calm", kind: "music", description: "Gentle piano-like notes over soft chords.", load: () => import("@/lib/experience/core/sounds").then((module) => ({ default: module.calm })) }
  ],
  shapes: [
    { shape: "marker", label: "Map pin", description: "A map pin that floats over a spot.", color: "#e03c31", size: 0.45, load: () => import("@/lib/experience/core/shapes").then((module) => ({ default: module.marker })) },
    { shape: "orb", label: "Glowing orb", description: "A softly glowing sphere.", color: "#7fd6ff", size: 0.3, load: () => import("@/lib/experience/core/shapes").then((module) => ({ default: module.orb })) },
    { shape: "box", label: "Box", description: "A plain box, for blocking out a prop.", color: "#d9cbb3", size: 0.4, load: () => import("@/lib/experience/core/shapes").then((module) => ({ default: module.box })) },
    { shape: "sign", label: "Sign", description: "A floating card that shows the object's text.", color: "#ffffff", size: 0.5, text: true, load: () => import("@/lib/experience/core/shapes").then((module) => ({ default: module.sign })) }
  ]
};

export default core;
