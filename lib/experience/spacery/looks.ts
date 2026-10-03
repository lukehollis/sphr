import type { LookEntry } from "@/lib/experience/registry";

/**
 * Spacery's looks, on top of the open source ones: styles from print, film,
 * games and science imaging. Each is the body of `vec3 look(vec2 uv)` in the
 * frame shader (see LookMeta in registry.ts).
 */

const amount = (key: string, label: string, value: number, min = 0, max = 1) => ({ key, label, type: "number" as const, min, max, step: 0.05, default: value });

export const spaceryLooks: LookEntry[] = [
  {
    id: "ink",
    label: "Manga ink",
    description: "Bold black outlines and screentone dots on white, like a comic book page.",
    backdrop: "#ffffff",
    params: [amount("dots", "Dot size", 6, 3, 12)],
    glsl: /* glsl */ `
      vec2 px = uv * uResolution;
      float l = LUM(SAMPLE(uv));
      float edge = smoothstep(0.22, 0.48, SOBEL(uv, 1.7));
      mat2 turn = mat2(0.7071, -0.7071, 0.7071, 0.7071);
      vec2 cell = fract(turn * px / P(dots)) - 0.5;
      float radius = sqrt(clamp(1.0 - l, 0.0, 1.0)) * 0.56;
      float tone = (1.0 - smoothstep(radius - 0.05, radius + 0.05, length(cell))) * smoothstep(0.9, 0.55, l);
      float black = 1.0 - smoothstep(0.07, 0.17, l);
      return mix(vec3(0.97, 0.96, 0.93), vec3(0.05), clamp(max(max(edge, black), tone), 0.0, 1.0));
    `
  },
  {
    id: "toon",
    label: "Cartoon",
    description: "Flat bands of bright color with dark outlines, like an animated film.",
    params: [amount("bands", "Color bands", 4, 2, 8), amount("outline", "Outlines", 1)],
    glsl: /* glsl */ `
      vec3 c = BLUR(uv, 1.2);
      float l = max(LUM(c), 0.04);
      float q = (floor(l * P(bands)) + 0.6) / P(bands);
      vec3 col = SATURATE(clamp(c / l * q, 0.0, 1.0), 1.4);
      float edge = smoothstep(0.2, 0.45, SOBEL(uv, 1.4)) * P(outline);
      return mix(col, vec3(0.06, 0.05, 0.08), edge);
    `
  },
  {
    id: "thermal",
    label: "Thermal camera",
    description: "Heat-camera colors from black through purple and red to white hot.",
    params: [amount("gain", "Gain", 1.1, 0.5, 2)],
    glsl: /* glsl */ `
      float t = clamp(LUM(BLUR(uv, 1.6)) * P(gain) + (NOISE(uv * 5.0 + uTime * 0.07) - 0.5) * 0.05, 0.0, 1.0);
      vec3 c = mix(vec3(0.02, 0.0, 0.06), vec3(0.18, 0.04, 0.45), smoothstep(0.0, 0.2, t));
      c = mix(c, vec3(0.62, 0.05, 0.42), smoothstep(0.2, 0.42, t));
      c = mix(c, vec3(0.93, 0.25, 0.05), smoothstep(0.42, 0.62, t));
      c = mix(c, vec3(1.0, 0.72, 0.05), smoothstep(0.62, 0.82, t));
      return mix(c, vec3(1.0, 0.98, 0.88), smoothstep(0.82, 1.0, t));
    `
  },
  {
    id: "nightvision",
    label: "Night vision",
    description: "Glowing green phosphor with noise, scanlines and a round scope.",
    params: [amount("brightness", "Brightness", 1.8, 1, 3)],
    glsl: /* glsl */ `
      vec2 px = uv * uResolution;
      float l = LUM(SAMPLE(uv)) * P(brightness) + LUM(BLUR(uv, 4.0)) * 0.6;
      l = pow(clamp(l, 0.0, 1.4), 0.85);
      float noise = HASH(px + fract(uTime * 61.0) * 1000.0) * 0.22;
      float scan = 0.9 + 0.1 * sin(px.y * 1.7);
      vec2 centered = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
      float scope = 1.0 - smoothstep(0.42, 0.5, length(centered) * 0.92);
      return vec3(0.18, 1.0, 0.35) * (l + noise) * scan * scope;
    `
  },
  {
    id: "oldfilm",
    label: "Old film",
    description: "Sepia silent film with grain, flicker, dust and scratches.",
    params: [amount("wear", "Wear", 0.6)],
    glsl: /* glsl */ `
      float frame = floor(uTime * 18.0);
      vec2 weave = vec2(0.0, (HASH(vec2(frame, 1.0)) - 0.5) * 0.004 * P(wear));
      float l = LUM(SAMPLE(uv + weave));
      vec3 c = vec3(l) * vec3(1.08, 0.94, 0.72) + vec3(0.05, 0.03, 0.0);
      c *= 0.92 + 0.08 * HASH(vec2(frame, 3.0));
      c += (HASH(uv * uResolution + frame) - 0.5) * 0.16 * P(wear);
      float x = uv.x * 90.0;
      float scratch = step(0.993, HASH(vec2(floor(x), floor(uTime * 5.0)))) * (1.0 - smoothstep(0.0, 0.25, abs(fract(x) - 0.5)));
      float speck = step(0.9996, HASH(floor(uv * uResolution / 2.0) + frame));
      vec2 centered = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
      c *= 1.0 - 0.7 * smoothstep(0.35, 0.95, length(centered));
      return clamp(c + (scratch * 0.35 + speck * 0.6) * P(wear) - step(0.9993, HASH(floor(uv * uResolution / 3.0) - frame)) * 0.5 * P(wear), 0.0, 1.0);
    `
  },
  {
    id: "neon",
    label: "Neon",
    description: "The space in the dark, traced in glowing neon lines. Draws from the line-drawing version of the space when one has been made.",
    variant: "sketch",
    params: [{ key: "a", label: "Color one", type: "color", default: "#00e5ff" }, { key: "b", label: "Color two", type: "color", default: "#ff2bd6" }],
    glsl: /* glsl */ `
      vec3 neon = mix(P(a), P(b), smoothstep(0.0, 1.0, uv.y + 0.25 * sin(uTime * 0.6 + uv.x * 3.0)));
      if (HAS_VARIANT > 0.5) {
        float drawn = DRAWN(uv);
        float halo = smoothstep(0.0, 0.5, 1.0 - LUM(BLUR(uv, 3.0)));
        return neon * (drawn * 1.15 + halo * 0.55);
      }
      float near = smoothstep(0.14, 0.5, SOBEL(uv, 1.0));
      float glow = smoothstep(0.08, 0.6, SOBEL(uv, 3.2));
      return SAMPLE(uv) * 0.07 + neon * (near * 1.15 + glow * 0.45);
    `
  },
  {
    id: "halftone",
    label: "Halftone print",
    description: "Cyan, magenta, yellow and black dots like a printed magazine.",
    backdrop: "#ffffff",
    params: [amount("size", "Dot size", 7, 4, 14)],
    glsl: /* glsl */ `
      vec2 px = uv * uResolution;
      vec3 page = vec3(0.98, 0.97, 0.93);
      vec3 result = page;
      for (int i = 0; i < 4; i++) {
        float angle = i == 0 ? 0.26 : i == 1 ? 1.31 : i == 2 ? 0.0 : 0.79;
        vec3 ink = i == 0 ? vec3(0.0, 0.68, 0.94) : i == 1 ? vec3(0.93, 0.05, 0.55) : i == 2 ? vec3(1.0, 0.9, 0.0) : vec3(0.1);
        mat2 turn = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
        vec2 grid = turn * px / P(size);
        vec2 center = (floor(grid) + 0.5) * P(size);
        vec3 c = SAMPLE(transpose(turn) * center / uResolution);
        float k = 1.0 - max(max(c.r, c.g), c.b);
        vec3 cmy = (1.0 - c - k) / max(1.0 - k, 0.001);
        float amount = i == 0 ? cmy.x : i == 1 ? cmy.y : i == 2 ? cmy.z : k;
        float radius = sqrt(clamp(amount, 0.0, 1.0)) * 0.62;
        float dot = 1.0 - smoothstep(radius - 0.06, radius + 0.06, length(fract(grid) - 0.5));
        result *= mix(vec3(1.0), ink, dot * 0.92);
      }
      return result;
    `
  },
  {
    id: "pixel",
    label: "Pixel art",
    description: "Big pixels in a game console palette, like an 8-bit game.",
    params: [
      amount("cells", "Pixels across", 160, 48, 320),
      { key: "palette", label: "Palette", type: "select", default: "free", options: [
        { value: "pico", label: "Fantasy console" }, { value: "gameboy", label: "Handheld green" }, { value: "free", label: "Any color" }
      ] }
    ],
    glsl: /* glsl */ `
      vec2 grid = vec2(P(cells), floor(P(cells) * uResolution.y / uResolution.x));
      vec2 cell = floor(uv * grid);
      vec3 c = SAMPLE((cell + 0.5) / grid);
      float dither = (HASH(cell) - 0.5) * 0.09;
      c = clamp(SATURATE(c, 1.2) + dither, 0.0, 1.0);
      if (P(palette) < 0.5) {
        vec3 best = vec3(0.0); float bestDistance = 9.0;
        for (int i = 0; i < 16; i++) {
          vec3 p = i == 0 ? vec3(0.0) : i == 1 ? vec3(0.114, 0.169, 0.325) : i == 2 ? vec3(0.494, 0.145, 0.325) : i == 3 ? vec3(0.0, 0.529, 0.318)
            : i == 4 ? vec3(0.671, 0.322, 0.212) : i == 5 ? vec3(0.373, 0.341, 0.31) : i == 6 ? vec3(0.761, 0.765, 0.78) : i == 7 ? vec3(1.0, 0.945, 0.91)
            : i == 8 ? vec3(1.0, 0.0, 0.302) : i == 9 ? vec3(1.0, 0.639, 0.0) : i == 10 ? vec3(1.0, 0.925, 0.153) : i == 11 ? vec3(0.0, 0.894, 0.212)
            : i == 12 ? vec3(0.161, 0.678, 1.0) : i == 13 ? vec3(0.514, 0.463, 0.612) : i == 14 ? vec3(1.0, 0.467, 0.659) : vec3(1.0, 0.8, 0.667);
          float d = distance(c, p);
          if (d < bestDistance) { bestDistance = d; best = p; }
        }
        c = best;
      } else if (P(palette) < 1.5) {
        float l = LUM(c);
        c = l < 0.25 ? vec3(0.059, 0.22, 0.059) : l < 0.5 ? vec3(0.188, 0.384, 0.188) : l < 0.75 ? vec3(0.545, 0.675, 0.059) : vec3(0.608, 0.737, 0.059);
      } else c = floor(c * 5.0 + 0.5) / 5.0;
      vec2 inside = fract(uv * grid);
      return c * (1.0 - step(0.9, max(inside.x, inside.y)) * 0.08);
    `
  },
  {
    id: "duotone",
    label: "Duotone",
    description: "Two inks only, shadows in one color and highlights in the other, like a screen-printed poster.",
    params: [{ key: "shadow", label: "Shadows", type: "color", default: "#0b3d91" }, { key: "light", label: "Highlights", type: "color", default: "#ffb38a" }],
    glsl: /* glsl */ `
      float l = smoothstep(0.04, 0.96, LUM(SAMPLE(uv)));
      return mix(P(shadow), P(light), l);
    `
  },
  {
    id: "xray",
    label: "X-ray",
    description: "Inverted, glowing blue-white structure, like an X-ray film.",
    backdrop: "#ffffff",
    params: [],
    glsl: /* glsl */ `
      float l = LUM(SAMPLE(uv));
      float edge = smoothstep(0.1, 0.5, SOBEL(uv, 1.2));
      return vec3(0.55, 0.85, 1.0) * pow(1.0 - l, 1.6) * 0.92 + vec3(0.8, 0.95, 1.0) * edge * 0.75;
    `
  },
  {
    id: "miniature",
    label: "Miniature",
    description: "Tilt-shift blur above and below a sharp band, so the space looks like a scale model.",
    params: [amount("focus", "Focus height", 0.45), amount("band", "Sharp band", 0.16, 0.02, 0.5), amount("blur", "Blur", 1, 0, 2)],
    glsl: /* glsl */ `
      float away = max(0.0, abs(uv.y - P(focus)) - P(band)) / max(0.05, 1.0 - P(band));
      vec3 c = mix(SAMPLE(uv), BLUR(uv, max(0.5, away * P(blur) * 9.0)), smoothstep(0.0, 0.12, away));
      c = SATURATE(c, 1.4);
      return clamp((c - 0.5) * 1.12 + 0.53, 0.0, 1.0);
    `
  },
  {
    id: "dream",
    label: "Dream",
    description: "Soft glowing light, pastel colors and a warm light leak.",
    params: [amount("glow", "Glow", 0.55)],
    glsl: /* glsl */ `
      vec3 c = SAMPLE(uv);
      vec3 glow = BLUR(uv, 6.0);
      c = 1.0 - (1.0 - c) * (1.0 - glow * P(glow));
      c = c * 0.84 + 0.12;
      vec3 leak = vec3(1.0, 0.56, 0.62) * (1.0 - smoothstep(0.0, 0.9, length(uv - vec2(0.08 + 0.08 * sin(uTime * 0.2), 0.95)))) * 0.38;
      return clamp(SATURATE(c, 0.85) + leak, 0.0, 1.0);
    `
  },
  {
    id: "vhs",
    label: "VHS tape",
    description: "A worn home video: color bleed, scanlines, wobble and a rolling tracking band.",
    params: [amount("wear", "Wear", 0.6)],
    glsl: /* glsl */ `
      float line = uv.y * uResolution.y;
      float band = 1.0 - smoothstep(0.0, 0.035, abs(uv.y - fract(1.0 - uTime * 0.06)));
      float jitter = ((NOISE(vec2(line * 0.05, uTime * 2.0)) - 0.5) * 0.004 + band * 0.012) * P(wear);
      vec2 shifted = uv + vec2(jitter, 0.0);
      float split = 0.0035 * P(wear);
      vec3 c = vec3(SAMPLE(shifted + vec2(split, 0.0)).r, SAMPLE(shifted).g, SAMPLE(shifted - vec2(split, 0.0)).b);
      c = mix(c, BLUR(shifted, 2.0), 0.3 * P(wear));
      c *= 0.92 + 0.08 * sin(line * 3.14159);
      c += (HASH(uv * uResolution + uTime) - 0.5) * 0.08 * P(wear) + band * 0.12 * HASH(vec2(line, uTime)) * P(wear);
      return clamp(SATURATE(c, 1.2), 0.0, 1.0);
    `
  },
  {
    id: "infrared",
    label: "Infrared",
    description: "False-color infrared film: foliage glows red and pink under deep skies.",
    params: [],
    glsl: /* glsl */ `
      vec3 c = SAMPLE(uv);
      vec3 ir = vec3(c.g * 1.15 + c.r * 0.15, c.r * 0.85 + c.g * 0.08, c.b * 0.95);
      return clamp(SATURATE(ir, 1.35) * 1.04, 0.0, 1.0);
    `
  },
  {
    id: "pointillism",
    label: "Pointillism",
    description: "Dabs of pure color on white, like a Seurat painting.",
    backdrop: "#f7f2e6",
    params: [amount("size", "Dot size", 9, 4, 16)],
    glsl: /* glsl */ `
      vec2 px = uv * uResolution;
      vec3 result = vec3(0.97, 0.95, 0.9);
      for (int layer = 0; layer < 2; layer++) {
        vec2 shift = layer == 0 ? vec2(0.0) : vec2(0.5);
        vec2 cell = floor(px / P(size) + shift);
        vec2 jitter = vec2(HASH(cell), HASH(cell + 7.1)) - 0.5;
        vec2 center = (cell - shift + 0.5 + jitter * 0.5) * P(size);
        vec3 c = SATURATE(SAMPLE(center / uResolution), 1.6);
        float radius = P(size) * (0.3 + 0.12 * HASH(cell + 3.3));
        float dab = 1.0 - smoothstep(radius - 1.0, radius, length(px - center));
        result = mix(result, c, dab);
      }
      return result;
    `
  },
  {
    id: "splatdots",
    label: "Gaussian dots",
    description: "Shrinks every Gaussian splat to a dot, showing the capture as the points it is made of.",
    requires: "splats",
    splats: { scale: 0.38, opacity: 1 },
    params: [{ key: "background", label: "Background", type: "color", default: "#0b0d12" }],
    glsl: /* glsl */ `
      return mix(P(background), clamp(SATURATE(SAMPLE(uv), 1.25) * 1.35, 0.0, 1.0), clamp(COVER(uv) * 1.6, 0.0, 1.0));
    `
  },
  {
    id: "cutout",
    label: "Paper cutout",
    description: "Turns every splat into a flat, hard-edged shape, like layered cut paper.",
    backdrop: "#f5f1e6",
    requires: "splats",
    splats: { falloff: 0, scale: 0.75 },
    params: [],
    glsl: /* glsl */ `
      vec3 c = SAMPLE(uv);
      return mix(vec3(0.96, 0.94, 0.89), floor(SATURATE(c, 1.2) * 7.0 + 0.5) / 7.0, clamp(COVER(uv) * 1.3, 0.0, 1.0));
    `
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "The space drawn in green text characters on a black screen.",
    params: [amount("size", "Character size", 9, 6, 16)],
    glsl: /* glsl */ `
      vec2 px = uv * uResolution;
      vec2 cellSize = vec2(P(size), P(size) * 1.6);
      vec2 cell = floor(px / cellSize);
      vec2 f = fract(px / cellSize);
      float l = pow(clamp(LUM(SAMPLE((cell + 0.5) * cellSize / uResolution)) * 1.35, 0.0, 1.0), 0.65);
      float level = floor(clamp(l * 1.1, 0.0, 0.999) * 8.0);
      vec2 p = (f - 0.5) * vec2(1.0, 1.6);
      float dot = 1.0 - step(0.09, length(p));
      float bar = step(abs(p.y), 0.06) * step(abs(p.x), 0.3);
      float post = step(abs(p.x), 0.06) * step(abs(p.y), 0.42);
      float diag = step(abs(p.x - p.y * 0.6), 0.07) * step(abs(p.y), 0.42);
      float anti = step(abs(p.x + p.y * 0.6), 0.07) * step(abs(p.y), 0.42);
      float hash = max(step(abs(abs(p.x) - 0.14), 0.05) * step(abs(p.y), 0.42), step(abs(abs(p.y) - 0.16), 0.05) * step(abs(p.x), 0.32));
      float block = step(abs(p.x), 0.34) * step(abs(p.y), 0.46);
      float glyph = level < 1.0 ? 0.0 : level < 2.0 ? dot : level < 3.0 ? max(dot, step(abs(p.y + 0.25), 0.07) * step(abs(p.x), 0.07)) : level < 4.0 ? bar
        : level < 5.0 ? max(bar, post) : level < 6.0 ? max(diag, anti) : level < 7.0 ? hash : block;
      glyph *= step(f.y, 0.94);
      return vec3(0.25, 1.0, 0.45) * glyph * (0.55 + 0.45 * l) + vec3(0.0, 0.035, 0.015);
    `
  },
  {
    id: "hologram",
    label: "Hologram",
    description: "A flickering cyan projection with scanlines and glowing edges.",
    params: [{ key: "tint", label: "Color", type: "color", default: "#4de8ff" }],
    glsl: /* glsl */ `
      float l = LUM(SAMPLE(uv));
      float edge = smoothstep(0.14, 0.5, SOBEL(uv, 1.2));
      float scan = 0.72 + 0.28 * sin(uv.y * uResolution.y * 0.9 - uTime * 6.0);
      float flicker = 0.93 + 0.07 * sin(uTime * 37.0) * step(0.8, HASH(vec2(floor(uTime * 10.0), 1.0)));
      return P(tint) * (l * 0.75 + edge * 0.95) * scan * flicker + vec3(0.0, 0.03, 0.06);
    `
  },
  {
    id: "cinematic",
    label: "Cinematic",
    description: "Teal and orange color grading with widescreen bars, like a feature film.",
    params: [amount("grade", "Grade", 0.7), { key: "bars", label: "Widescreen bars", type: "boolean", default: true }],
    glsl: /* glsl */ `
      vec3 c = SAMPLE(uv);
      float l = LUM(c);
      vec3 graded = mix(vec3(0.0, 0.28, 0.36), vec3(1.0, 0.62, 0.32), smoothstep(0.1, 0.9, l));
      c = mix(c, c * 0.6 + graded * l * 0.75, P(grade));
      c = clamp((c - 0.5) * 1.12 + 0.5, 0.0, 1.0);
      float barHeight = max(0.0, (1.0 - (uResolution.x / uResolution.y) / 2.39) * 0.5);
      if (P(bars) > 0.5 && (uv.y < barHeight || uv.y > 1.0 - barHeight)) return vec3(0.0);
      return c;
    `
  }
];
