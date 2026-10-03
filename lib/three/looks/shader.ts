import type { LookMeta, ParamSpec } from "@/lib/experience/registry";
import type { LookTransition } from "@/lib/experience/types";

/**
 * Builds one full-screen fragment shader for a look, or for a transition from
 * one look to another. Each look is a GLSL body for `vec3 look(vec2 uv)`; its
 * parameters become uniforms named after the slot (A or B) it is compiled into.
 */

export const LOOK_HELPERS = /* glsl */ `
  uniform sampler2D tFrame;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uProgress;
  uniform vec3 uRayX;
  uniform vec3 uRayY;
  uniform vec3 uRayZ;
  uniform vec3 uDirection;
  uniform vec2 uCenter;
  uniform vec3 uFrontColor;
  varying vec2 vUv;
  #define PX (1.0 / uResolution)

  vec3 toDisplay(vec3 c) {
    c = max(c, vec3(0.0));
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
  }
  // Set by each look before it runs: what shows where the space leaves gaps (linear color).
  vec3 gBackdrop = vec3(0.003);
  vec3 SAMPLE(vec2 uv) {
    vec4 frame = texture2D(tFrame, clamp(uv, PX * 0.5, 1.0 - PX * 0.5));
    return clamp(toDisplay(frame.rgb + gBackdrop * (1.0 - clamp(frame.a, 0.0, 1.0))), 0.0, 1.0);
  }
  float LUM(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  float COVER(vec2 uv) { return texture2D(tFrame, uv).a; }
  float HASH(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float NOISE(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(HASH(i), HASH(i + vec2(1.0, 0.0)), u.x), mix(HASH(i + vec2(0.0, 1.0)), HASH(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float SOBEL(vec2 uv, float width) {
    vec2 d = PX * width;
    float tl = LUM(SAMPLE(uv + vec2(-d.x, d.y))), tc = LUM(SAMPLE(uv + vec2(0.0, d.y))), tr = LUM(SAMPLE(uv + vec2(d.x, d.y)));
    float ml = LUM(SAMPLE(uv + vec2(-d.x, 0.0))), mr = LUM(SAMPLE(uv + vec2(d.x, 0.0)));
    float bl = LUM(SAMPLE(uv + vec2(-d.x, -d.y))), bc = LUM(SAMPLE(uv + vec2(0.0, -d.y))), br = LUM(SAMPLE(uv + vec2(d.x, -d.y)));
    float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
    float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
    return length(vec2(gx, gy));
  }
  /** Line strength 0..1 from luminance edges at two scales, so both outlines and detail draw. */
  float EDGES(vec2 uv, float width) {
    float coarse = smoothstep(0.2, 0.58, SOBEL(uv, width * 1.6));
    float fine = smoothstep(0.28, 0.7, SOBEL(uv, width * 0.8));
    return clamp(max(coarse, fine * 0.6), 0.0, 1.0);
  }
  vec3 BLUR(vec2 uv, float radius) {
    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (int x = -2; x <= 2; x++) for (int y = -2; y <= 2; y++) {
      float w = exp(-float(x * x + y * y) / 4.0);
      sum += SAMPLE(uv + vec2(float(x), float(y)) * PX * radius) * w;
      total += w;
    }
    return sum / total;
  }
  vec3 SATURATE(vec3 c, float amount) { return mix(vec3(LUM(c)), c, amount); }
  /** Direction of the view ray through this pixel, in world space. */
  vec3 RAY(vec2 uv) { vec2 ndc = uv * 2.0 - 1.0; return normalize(uRayZ + ndc.x * uRayX + ndc.y * uRayY); }
`;

/** Mask 0..1 of how far the transition has reached at a pixel, and a glow at its front. */
export const TRANSITION_GLSL: Record<LookTransition, string> = {
  cut: `return vec2(step(0.5, uProgress), 0.0);`,
  fade: `return vec2(smoothstep(0.0, 1.0, uProgress), 0.0);`,
  dissolve: `
    float grain = HASH(floor(uv * uResolution / 3.0));
    float n = NOISE(uv * vec2(9.0, 6.0)) * 0.6 + grain * 0.4;
    float m = smoothstep(n - 0.04, n + 0.04, uProgress * 1.08 - 0.04);
    return vec2(m, 0.0);`,
  wipe: `
    float edge = uProgress * 1.2 - 0.1;
    float x = uv.x + (NOISE(vec2(uv.y * 8.0, uTime)) - 0.5) * 0.015;
    float m = 1.0 - smoothstep(edge - 0.01, edge + 0.01, x);
    return vec2(m, 1.0 - smoothstep(0.0, 0.012, abs(x - edge)));`,
  iris: `
    vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
    float d = length((uv - uCenter) * aspect);
    float radius = uProgress * 1.9;
    float m = 1.0 - smoothstep(radius - 0.015, radius + 0.015, d);
    return vec2(m, (1.0 - smoothstep(0.0, 0.02, abs(d - radius))) * step(0.001, uProgress) * step(uProgress, 0.999));`,
  sweep: `
    float angle = acos(clamp(dot(RAY(uv), uDirection), -1.0, 1.0));
    float front = uProgress * 3.5 - 0.1;
    float m = 1.0 - smoothstep(front - 0.03, front + 0.03, angle);
    return vec2(m, (1.0 - smoothstep(0.0, 0.06, abs(angle - front))) * step(0.001, uProgress) * step(uProgress, 0.999));`,
  glitch: `
    vec2 block = floor(uv * vec2(14.0, 30.0) + vec2(0.0, floor(uTime * 18.0)));
    float n = HASH(block);
    float m = step(n, uProgress * 1.15 - 0.05);
    return vec2(m, step(0.86, HASH(block + 3.1)) * (1.0 - abs(uProgress * 2.0 - 1.0)));`
};

function paramUniform(spec: ParamSpec, slot: string) {
  return spec.type === "color" ? `uniform vec3 u${slot}_${spec.key};` : `uniform float u${slot}_${spec.key};`;
}

function lookFunction(meta: LookMeta | null, slot: "A" | "B") {
  if (!meta) return `vec3 look${slot}(vec2 uv) { gBackdrop = vec3(0.003); return SAMPLE(uv); }`;
  const body = meta.glsl
    .replace(/\bP\((\w+)\)/g, (_match, key: string) => `u${slot}_${key}`)
    .replace(/\bHAS_VARIANT\b/g, `u${slot}_hasVariant`);
  return `${meta.params.map((spec) => paramUniform(spec, slot)).join("\n")}
uniform float u${slot}_hasVariant;
uniform vec3 u${slot}_backdrop;
vec3 look${slot}(vec2 uv) {
gBackdrop = u${slot}_backdrop;
${body}
}`;
}

/** The fragment shader for one look, or for a transition between two. */
export function lookFragment(from: LookMeta | null, to: LookMeta | null, transition: LookTransition | null) {
  const mixing = transition !== null;
  return `${LOOK_HELPERS}
${mixing ? lookFunction(from, "A") : ""}
${lookFunction(to, "B")}
${mixing ? `vec2 transitionMask(vec2 uv) { ${TRANSITION_GLSL[transition]} }` : ""}
void main() {
  vec3 color = lookB(vUv);
  ${mixing ? `vec2 mask = transitionMask(vUv);
  vec3 before = lookA(${transition === "glitch" ? "vUv + vec2((HASH(floor(vUv * vec2(1.0, 40.0)) + uTime) - 0.5) * 0.04 * (1.0 - mask.x) * step(0.5, HASH(vec2(floor(uTime * 20.0)))), 0.0)" : "vUv"});
  color = mix(before, color, mask.x) + uFrontColor * mask.y;` : ""}
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;
}

export const LOOK_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
