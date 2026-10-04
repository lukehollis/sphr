import type { SkyEntry } from "@/lib/experience/registry";

/**
 * Skies drawn in the shader from a few colors, so the open source pack has skies
 * without shipping images. Photographed skies come in larger packs.
 */
export const coreSkies: SkyEntry[] = [
  {
    id: "drawn-day", label: "Blue sky", kind: "day", light: "#ffffff", sun: [0.62, 0.22],
    description: "A clear blue sky with a high sun, drawn rather than photographed.",
    gradient: { zenith: "#2f6fc0", horizon: "#bcd8f0", ground: "#8d9aa6", sun: { color: "#fff6e0", size: 0.03 } }
  },
  {
    id: "drawn-sunset", label: "Sunset glow", kind: "sunset", light: "#ffc69a", sun: [0.6, 0.485],
    description: "A warm orange glow along the horizon with the sun going down, drawn rather than photographed.",
    gradient: { zenith: "#3a5a92", horizon: "#ffa860", ground: "#6b5a55", sun: { color: "#ffd9a0", size: 0.035 } }
  },
  {
    id: "drawn-twilight", label: "Twilight", kind: "dusk", light: "#a9a2cf",
    description: "Deep blue twilight with the first stars, drawn rather than photographed.",
    gradient: { zenith: "#101a3c", horizon: "#c2869a", ground: "#2c2a38", stars: 0.35 }
  },
  {
    id: "drawn-night", label: "Starry night", kind: "night", light: "#4b5b8c", sun: [0.3, 0.2],
    description: "A dark night full of stars with a small moon, drawn rather than photographed.",
    gradient: { zenith: "#02040b", horizon: "#16203a", ground: "#07080d", sun: { color: "#e8eeff", size: 0.012 }, stars: 1 }
  },
  {
    id: "drawn-overcast", label: "Gray sky", kind: "cloudy", light: "#dde1e6",
    description: "An even, quiet gray sky with soft light, drawn rather than photographed.",
    gradient: { zenith: "#9aa3ad", horizon: "#d4d8dc", ground: "#8a8f94" }
  }
];
