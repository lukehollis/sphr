import type { LookEntry } from "@/lib/experience/registry";

/**
 * The open source looks. Each is the body of `vec3 look(vec2 uv)` in the frame
 * shader (see LookMeta in registry.ts for what it can call).
 */

const paper = { key: "paper", label: "Paper", type: "color", default: "#f4f1e8" } as const;
const ink = { key: "ink", label: "Ink", type: "color", default: "#1d1c1a" } as const;

export const lines: LookEntry = {
  id: "lines",
  label: "Line drawing",
  description: "Ink lines on paper, like a hand drawing of the space. Uses a version of the space drawn by a line-drawing model when one has been made, otherwise draws its edges.",
  variant: "sketch",
  backdrop: "#f4f1e8",
  params: [
    paper, ink,
    { key: "weight", label: "Line weight", type: "number", min: 0.6, max: 3, step: 0.1, default: 1.3 },
    { key: "hatching", label: "Shading", type: "number", min: 0, max: 1, step: 0.05, default: 0.55 },
    { key: "color", label: "Color wash", type: "number", min: 0, max: 1, step: 0.05, default: 0 }
  ],
  glsl: /* glsl */ `
    vec2 px = uv * uResolution;
    vec3 src = SAMPLE(uv);
    float tooth = NOISE(px / 2.2) * 0.5 + NOISE(px / 11.0) * 0.5;
    vec3 page = P(paper) * (0.965 + 0.035 * tooth);
    if (HAS_VARIANT > 0.5) {
      // The space itself is drawn: white becomes paper, black becomes ink.
      vec3 drawn = mix(P(ink), page, src);
      return mix(drawn, drawn * mix(vec3(1.0), BLUR(uv, 4.0) * 1.2, P(color)), P(color));
    }
    float l = LUM(src);
    float wobble = NOISE(px / 37.0);
    float edge = EDGES(uv, P(weight)) * (0.82 + 0.36 * wobble);
    float shade = 1.0 - smoothstep(0.06, 0.62, l);
    float hatch = step(0.76, fract((px.x - px.y + wobble * 6.0) / 6.0)) * smoothstep(0.3, 0.62, shade);
    float cross = step(0.8, fract((px.x + px.y + wobble * 6.0) / 7.0)) * smoothstep(0.62, 0.92, shade);
    float marks = clamp(edge + (hatch * 0.55 + cross * 0.6) * P(hatching), 0.0, 1.0);
    vec3 wash = mix(page, page * SATURATE(BLUR(uv, 3.0), 1.25) * 1.12, P(color));
    return mix(wash, P(ink), marks);
  `
};

export const watercolor: LookEntry = {
  id: "watercolor",
  label: "Watercolor",
  description: "Soft washes of color with ink lines on top, on textured paper. Uses a painted version of the space when one has been made.",
  variant: "watercolor",
  backdrop: "#f4f1e8",
  params: [
    paper,
    { key: "pigment", label: "Color strength", type: "number", min: 0.5, max: 2, step: 0.05, default: 1.3 },
    { key: "bleed", label: "Softness", type: "number", min: 1, max: 8, step: 0.5, default: 3.5 },
    { key: "lines", label: "Ink lines", type: "number", min: 0, max: 1, step: 0.05, default: 0.65 }
  ],
  glsl: /* glsl */ `
    vec2 px = uv * uResolution;
    float tooth = NOISE(px / 2.5) * 0.55 + NOISE(px / 13.0) * 0.45;
    if (HAS_VARIANT > 0.5) return SAMPLE(uv) * mix(vec3(1.0), P(paper), 0.35) * (0.94 + 0.08 * tooth);
    vec3 wash = SATURATE(BLUR(uv, P(bleed)), P(pigment));
    // Washes settle flatter, and pigment pools where they meet.
    wash = mix(wash, floor(wash * 6.0 + 0.5) / 6.0, 0.35);
    float pool = smoothstep(0.08, 0.5, SOBEL(uv, P(bleed) * 1.4));
    wash *= 1.0 - pool * 0.22;
    wash = mix(wash, P(paper), 0.1 + tooth * 0.16);
    float line = EDGES(uv, 1.0) * P(lines);
    return mix(wash * mix(vec3(1.0), P(paper), 0.4), wash * 0.28, line * 0.85);
  `
};

export const blueprint: LookEntry = {
  id: "blueprint",
  label: "Blueprint",
  description: "White lines on blueprint blue over a drafting grid, like an architect's drawing of the space. Draws from the line-drawing version of the space when one has been made.",
  variant: "sketch",
  params: [
    { key: "paper", label: "Paper", type: "color", default: "#123f78" },
    { key: "line", label: "Lines", type: "color", default: "#e9f3ff" },
    { key: "grid", label: "Grid", type: "number", min: 0, max: 1, step: 0.05, default: 0.6 },
    { key: "fill", label: "Tone", type: "number", min: 0, max: 0.6, step: 0.02, default: 0.16 }
  ],
  glsl: /* glsl */ `
    vec2 px = uv * uResolution;
    vec3 src = SAMPLE(uv);
    float l = LUM(src);
    // A drawn version gives clean lines (dark on white); otherwise trace the photo's edges.
    float edge = HAS_VARIANT > 0.5 ? smoothstep(0.25, 0.85, 1.0 - l) : EDGES(uv, 1.2);
    edge *= 0.78 + 0.22 * NOISE(px / 2.5);
    if (HAS_VARIANT > 0.5) l = 0.0;
    vec2 centered = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
    vec3 base = P(paper) * (0.8 + 0.2 * (1.0 - smoothstep(0.3, 1.1, length(centered))));
    base = mix(base, P(line), smoothstep(0.15, 0.95, l) * P(fill));
    float minor = max(step(fract(px.x / 24.0), 1.2 / 24.0), step(fract(px.y / 24.0), 1.2 / 24.0));
    float major = max(step(fract(px.x / 120.0), 2.2 / 120.0), step(fract(px.y / 120.0), 2.2 / 120.0));
    base = mix(base, P(line), (minor * 0.06 + major * 0.11) * P(grid));
    return mix(base, P(line), clamp(edge * 1.1, 0.0, 1.0));
  `
};

export const noir: LookEntry = {
  id: "noir",
  label: "Film noir",
  description: "High-contrast black and white with grain and a dark vignette.",
  params: [
    { key: "contrast", label: "Contrast", type: "number", min: 1, max: 2.5, step: 0.05, default: 1.6 },
    { key: "grain", label: "Grain", type: "number", min: 0, max: 1, step: 0.05, default: 0.35 },
    { key: "vignette", label: "Vignette", type: "number", min: 0, max: 1, step: 0.05, default: 0.65 }
  ],
  glsl: /* glsl */ `
    float l = LUM(SAMPLE(uv));
    l = smoothstep(0.0, 1.0, clamp((l - 0.45) * P(contrast) + 0.5, 0.0, 1.0));
    float grain = (HASH(uv * uResolution + fract(uTime * 13.0) * 97.0) - 0.5) * P(grain) * 0.3;
    float vignette = 1.0 - P(vignette) * smoothstep(0.3, 0.95, length((uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0)));
    return vec3(clamp((l + grain) * vignette, 0.0, 1.0));
  `
};

export const coreLooks: LookEntry[] = [lines, watercolor, blueprint, noir];
