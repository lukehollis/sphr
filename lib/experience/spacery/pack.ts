import type { EffectEntry, Pack, ShapeEntry, SoundEntry } from "@/lib/experience/registry";

/** Spacery's own effects and collectibles for app.spacery.dev, beyond the open source core. */

const color = (key: string, label: string, value: string) => ({ key, label, type: "color" as const, default: value });
const number = (key: string, label: string, min: number, max: number, value: number, step?: number) => ({ key, label, type: "number" as const, min, max, default: value, ...(step ? { step } : {}) });
const select = (key: string, label: string, value: string, options: [string, string][]) => ({ key, label, type: "select" as const, default: value, options: options.map(([option, name]) => ({ value: option, label: name })) });

const effects: EffectEntry[] = [
  { type: "bloom", label: "Blooming flowers", description: "Flowers grow with a puff of sparkles wherever visitors hover the ground, or a patch of flowers blooms around the target, like the original garden tour.",
    targets: ["scene", "point", "object"],
    params: [select("mode", "Behavior", "hover", [["hover", "Grow where the pointer hovers"], ["patch", "Bloom around the target"]]), select("flowers", "Flowers", "garden", [["garden", "Garden flowers"], ["simple", "Simple flowers"]]),
      color("color", "Simple flower color", "#ff6b9a"), number("count", "Most at once", 5, 120, 30, 1), number("size", "Size", 0.3, 3, 1, 0.1), number("radius", "Patch size (m)", 0.2, 6, 1, 0.1),
      { key: "sparkles", label: "Sparkles", type: "boolean", default: true }],
    load: () => import("@/lib/experience/spacery/bloom") },
  { type: "fireflies", label: "Fireflies", description: "Warm motes that wander slowly and blink on and off, around the target or wherever the visitor stands.",
    targets: ["scene", "object", "point"],
    params: [color("color", "Color", "#d8ff6a"), number("count", "Amount", 10, 600, 120, 1), number("size", "Size", 0.3, 3, 1, 0.1), number("radius", "Spread (m)", 0.5, 20, 4, 0.5), number("speed", "Speed", 0.1, 3, 1, 0.1)],
    load: () => import("@/lib/experience/spacery/fireflies") },
  { type: "snow", label: "Snow", description: "Snow falling and swaying around the visitor or over the target.",
    targets: ["scene", "point"],
    params: [color("color", "Color", "#ffffff"), number("count", "Amount", 200, 6000, 2500, 50), number("size", "Flake size", 0.3, 3, 1, 0.1), number("speed", "Fall speed", 0.2, 3, 1, 0.1), number("wind", "Wind", -2, 2, 0, 0.1), number("radius", "Spread (m)", 2, 30, 8, 1)],
    load: () => import("@/lib/experience/spacery/snow") },
  { type: "rain", label: "Rain", description: "Streaks of rain falling around the visitor.",
    targets: ["scene"],
    params: [color("color", "Color", "#b9c8d6"), number("count", "Amount", 200, 6000, 2500, 50), number("speed", "Speed", 0.3, 3, 1, 0.1), number("wind", "Wind", -3, 3, 0.5, 0.1), number("radius", "Spread (m)", 2, 30, 8, 1)],
    load: () => import("@/lib/experience/spacery/rain") },
  { type: "confetti", label: "Confetti", description: "Paper confetti thrown up from the target, once when the stop opens or a hunt item is found, or in repeating bursts.",
    targets: ["object", "point", "scene"], oneShot: true,
    params: [select("mode", "Behavior", "once", [["once", "Once"], ["loop", "Keep throwing"]]), select("palette", "Colors", "party", [["party", "Party"], ["gold", "Gold"], ["nasa", "NASA"], ["pastel", "Pastel"]]), number("count", "Pieces", 20, 400, 160, 10), number("spread", "Spread", 0.3, 3, 1, 0.1)],
    load: () => import("@/lib/experience/spacery/confetti") },
  { type: "glitter", label: "Glitter", description: "Points of light twinkle across the capture like frost or fairy dust, everywhere or within a radius of the target.",
    targets: ["scene", "point", "object"],
    params: [color("color", "Color", "#fff6da"), number("amount", "Amount", 0.01, 0.6, 0.1, 0.01), number("radius", "Radius (m, 0 for all)", 0, 40, 0, 0.5)],
    load: () => import("@/lib/experience/spacery/glitter") },
  { type: "dissolve", label: "Sand dissolve", description: "The capture crumbles into drifting sand and gathers back together, splat by splat, from the target outward.",
    targets: ["scene", "point"], requires: "splats",
    params: [select("mode", "Behavior", "in", [["in", "Assemble from sand"], ["out", "Crumble away"], ["cycle", "Breathe in and out"]]), color("color", "Sand color", "#d9c39a"), number("duration", "Duration (s)", 0.5, 12, 4, 0.5)],
    load: () => import("@/lib/experience/spacery/dissolve") },
  { type: "hologram", label: "Hologram", description: "Turns the space, or a sphere of it around the target, into a flickering projection with scan lines.",
    targets: ["scene", "point", "object"],
    params: [color("color", "Color", "#53e3ff"), number("lines", "Lines per meter", 1, 30, 6, 1), number("radius", "Radius (m, 0 for all)", 0, 40, 0, 0.5)],
    load: () => import("@/lib/experience/spacery/hologram") },
  { type: "wave", label: "Wave", description: "Ripples roll out through the splats from the target like a stone dropped in water.",
    targets: ["point", "object", "scene"], requires: "splats",
    params: [color("color", "Crest color", "#bfe9ff"), number("height", "Height (m)", 0.01, 1, 0.15, 0.01), number("wavelength", "Wavelength (m)", 0.2, 8, 1.5, 0.1), number("speed", "Speed", 0.2, 10, 3, 0.1), number("reach", "Reach (m)", 0.5, 40, 6, 0.5)],
    load: () => import("@/lib/experience/spacery/wave") },
  { type: "points", label: "Point cloud", description: "Shrinks every splat to a bright point, showing the capture as the cloud of measurements it grew from.",
    targets: ["scene"], requires: "splats",
    params: [color("color", "Glow color", "#9fd8ff"), number("size", "Point size (m)", 0.002, 0.05, 0.012, 0.001), number("glow", "Glow", 0, 2, 0.5, 0.05)],
    load: () => import("@/lib/experience/spacery/points") },
  { type: "flashlight", label: "Flashlight", description: "Darkness over the view with a pool of light where the pointer rests, for night walks and hide and seek.",
    targets: ["scene", "object", "point"],
    params: [number("radius", "Light size", 0.05, 0.6, 0.2, 0.01), number("darkness", "Darkness", 0.3, 1, 0.92, 0.01), select("follow", "Light follows", "pointer", [["pointer", "The pointer"], ["target", "The target"]])],
    load: () => import("@/lib/experience/spacery/flashlight") },
  { type: "mood", label: "Mood", description: "A color mood over the whole view: night, golden hour, dream, noir, underwater or ember.",
    targets: ["scene"],
    params: [select("mood", "Mood", "night", [["night", "Night"], ["golden", "Golden hour"], ["dream", "Dream"], ["noir", "Noir"], ["underwater", "Underwater"], ["ember", "Ember"]]), number("intensity", "Intensity", 0.1, 1.5, 1, 0.05)],
    load: () => import("@/lib/experience/spacery/mood") },
  { type: "ripple", label: "Ground ripples", description: "Rings spreading across the ground from the target, like water or a sound wave.",
    targets: ["object", "point"],
    params: [color("color", "Color", "#bfe9ff"), number("radius", "Radius (m)", 0.3, 10, 2, 0.1), number("rings", "Rings", 1, 6, 4, 1), number("speed", "Speed", 0.2, 4, 1, 0.1)],
    load: () => import("@/lib/experience/spacery/ripple") },
  { type: "portal", label: "Portal", description: "A swirling doorway of light standing at the target and turning to face the visitor.",
    targets: ["point", "object"],
    params: [color("color", "Inner color", "#7a5cff"), color("rim", "Rim color", "#9ff3ff"), number("size", "Height (m)", 0.5, 6, 2, 0.1)],
    load: () => import("@/lib/experience/spacery/portal") },
  { type: "lightshaft", label: "Light shaft", description: "A shaft of light falling on the target from above, with dust turning in it.",
    targets: ["object", "point"],
    params: [color("color", "Color", "#fff3d1"), number("radius", "Width at the floor (m)", 0.2, 5, 0.8, 0.1), number("height", "Height (m)", 1, 30, 6, 0.5)],
    load: () => import("@/lib/experience/spacery/lightshaft") },
  { type: "orbit", label: "Orbiting lights", description: "Bright motes circling the target on tilted rings, each with a short comet tail.",
    targets: ["object", "point"],
    params: [color("color", "Color", "#9ff3ff"), number("count", "Lights", 1, 24, 12, 1), number("radius", "Radius (m)", 0.1, 5, 0.5, 0.05), number("speed", "Speed", 0.1, 5, 1, 0.1)],
    load: () => import("@/lib/experience/spacery/orbit") },
  { type: "halo", label: "Halo", description: "A soft glow around an object, a rim of light on its surface and a halo behind it, that pulses gently.",
    targets: ["object"],
    params: [color("color", "Color", "#ffe9a8"), number("strength", "Strength", 0.1, 2, 1, 0.05), number("pulse", "Pulse", 0, 3, 1, 0.1)],
    load: () => import("@/lib/experience/spacery/halo") },
  { type: "fog", label: "Ground fog", description: "Low banks of mist drifting along the floor around the target or the visitor.",
    targets: ["scene", "point", "object"],
    params: [color("color", "Color", "#e8eef2"), number("density", "Density", 0.1, 2, 1, 0.05), number("radius", "Spread (m)", 1, 20, 6, 0.5), number("height", "Height (m)", 0.1, 2, 0.6, 0.05)],
    load: () => import("@/lib/experience/spacery/fog") }
];

const shape = (name: keyof typeof import("@/lib/experience/spacery/shapes")) => () => import("@/lib/experience/spacery/shapes").then((module) => ({ default: module[name] }));

const shapes: ShapeEntry[] = [
  { shape: "gem", label: "Gem", description: "A cut gem with a soft inner glow.", color: "#38d1ff", size: 0.3, load: shape("gem") },
  { shape: "coin", label: "Gold coin", description: "A standing gold coin stamped with a star.", color: "#f4c542", size: 0.2, load: shape("coin") },
  { shape: "star", label: "Star", description: "A thick golden star.", color: "#ffd23f", size: 0.32, load: shape("star") },
  { shape: "key", label: "Old key", description: "A brass skeleton key standing on its bit.", color: "#c9a227", size: 0.24, load: shape("key") },
  { shape: "chest", label: "Treasure chest", description: "A wooden chest with brass bands and a lock.", color: "#7a4a24", size: 0.42, load: shape("chest") },
  { shape: "trophy", label: "Trophy", description: "A gold cup on a dark base.", color: "#f4c542", size: 0.36, load: shape("trophy") },
  { shape: "lantern", label: "Lantern", description: "A small black lantern with glowing glass.", color: "#ffcf7a", size: 0.3, load: shape("lantern") },
  { shape: "arrow", label: "Arrow", description: "A flat arrow pointing up, turn it to point the way.", color: "#e03c31", size: 0.32, load: shape("arrow") },
  { shape: "question", label: "Question mark", description: "A glowing question mark.", color: "#8b5cf6", size: 0.36, load: shape("question") },
  { shape: "heart", label: "Heart", description: "A glossy heart.", color: "#ff4f6d", size: 0.26, load: shape("heart") },
  { shape: "crystal", label: "Crystal cluster", description: "A cluster of glowing crystal shards.", color: "#7ef9ff", size: 0.3, load: shape("crystal") },
  { shape: "flower", label: "Flower", description: "A single flower with a leaf.", color: "#ff6b9a", size: 0.3, load: shape("flower") },
  { shape: "balloon", label: "Balloon", description: "A balloon floating on its string.", color: "#ff4f6d", size: 0.78, load: shape("balloon") }
];

const sound = (name: keyof typeof import("@/lib/experience/spacery/sounds")) => () => import("@/lib/experience/spacery/sounds").then((module) => ({ default: module[name] }));

const sounds: SoundEntry[] = [
  { id: "garden-music", label: "Peaceful garden", kind: "music", description: "Soft acoustic music from the original garden tour.", load: sound("gardenMusic") },
  { id: "wonder", label: "Wonder", kind: "music", description: "Bright, rising arpeggios for discovery and big reveals.", load: sound("wonder") },
  { id: "mystery", label: "Mystery", kind: "music", description: "Sparse minor chords and distant bells, for hunts and old places.", load: sound("mystery") },
  { id: "adventure", label: "Adventure", kind: "music", description: "A driving pulse with bold arpeggios, for quests.", load: sound("adventure") },
  { id: "playful", label: "Playful", kind: "music", description: "Bouncy major melody, for kids and games.", load: sound("playful") },
  { id: "nocturne", label: "Nocturne", kind: "music", description: "Slow, warm minor chords for night and reflection.", load: sound("nocturne") },
  { id: "garden-birds", label: "Garden birds", kind: "ambient", description: "Recorded birdsong in a backyard garden.", load: sound("gardenBirds") },
  { id: "night-ambience", label: "Night", kind: "ambient", description: "A recorded night soundscape.", load: sound("nightAmbience") },
  { id: "wind", label: "Wind", kind: "ambient", description: "Wind with slow gusts, for open sites and heights.", load: sound("wind") },
  { id: "rain", label: "Rain", kind: "ambient", description: "Steady rain with drops.", load: sound("rain") },
  { id: "waves", label: "Waves", kind: "ambient", description: "Surf rolling in and out, for coasts and harbors.", load: sound("waves") },
  { id: "forest", label: "Forest", kind: "ambient", description: "Leaves and scattered bird calls.", load: sound("forest") },
  { id: "fire", label: "Fire", kind: "ambient", description: "A crackling fire.", load: sound("fire") },
  { id: "cave", label: "Cave", kind: "ambient", description: "A low drone with dripping water, for caves, tombs and crypts.", load: sound("cave") },
  { id: "space", label: "Space", kind: "ambient", description: "A deep, slowly shifting drone with distant tones.", load: sound("space") },
  { id: "crickets", label: "Crickets", kind: "ambient", description: "Crickets on a warm night.", load: sound("crickets") },
  { id: "ding", label: "Ding", kind: "sfx", description: "The interface ding from the garden tour.", load: sound("ding") },
  { id: "drum", label: "Soft drum", kind: "sfx", description: "A soft bass drum hit, for emphasis.", load: sound("drum") },
  { id: "temple-bell", label: "Temple bell", kind: "sfx", description: "A deep struck bell.", load: sound("lowBell") },
  { id: "temple-bell-high", label: "Temple bell (higher)", kind: "sfx", description: "A struck bell a little higher.", load: sound("lowBellHigh") },
  { id: "coin", label: "Coin", kind: "sfx", description: "A classic game coin pickup.", load: sound("coin") },
  { id: "magic", label: "Magic", kind: "sfx", description: "A shimmering magical rise, for portals and transformations.", load: sound("magic") },
  { id: "harp", label: "Harp", kind: "sfx", description: "A harp glissando, for transitions and dreams.", load: sound("harp") },
  { id: "gong", label: "Gong", kind: "sfx", description: "A long ringing gong.", load: sound("gong") },
  { id: "shutter", label: "Camera shutter", kind: "sfx", description: "A camera shutter click.", load: sound("shutter") },
  { id: "fanfare", label: "Fanfare", kind: "sfx", description: "A short triumphant brass fanfare, for finishing a hunt.", load: sound("fanfare") }
];

const spacery: Pack = { id: "spacery", label: "Spacery", effects, shapes, sounds };

export default spacery;
