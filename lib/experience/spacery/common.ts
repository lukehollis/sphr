import * as THREE from "three";

/** Ease a value toward a target at a rate per second, settling exactly. */
export function approach(value: number, target: number, delta: number, rate = 3) {
  const next = value + (target - value) * Math.min(1, delta * rate);
  return Math.abs(target - next) < 0.002 ? target : next;
}

export const pixelRatio = () => Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio, 2);

/** 3D simplex noise (Ashima Arts, MIT), for shaders. */
export const NOISE = /* glsl */ `
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }
`;

export const HASH = /* glsl */ `
  float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float hash31(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
`;

/** A field of points that wraps around a moving center, for weather and motes. */
export function wrappedPoints(count: number, extra: Record<string, THREE.BufferAttribute> = {}) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = Math.random() * 2 - 1;
    positions[index * 3 + 1] = Math.random() * 2 - 1;
    positions[index * 3 + 2] = Math.random() * 2 - 1;
    seeds[index] = Math.random();
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  for (const [name, attribute] of Object.entries(extra)) geometry.setAttribute(name, attribute);
  return geometry;
}

/** World point wrapped into a box of half extents uHalf around uCenter. */
export const WRAP = /* glsl */ `
  vec3 wrapAround(vec3 p, vec3 center, vec3 halfSize) {
    return center + mod(p - center + halfSize, halfSize * 2.0) - halfSize;
  }
`;

/** Soft round sprite texture shared by sprites. */
let glow: THREE.Texture | null = null;
export function glowTexture() {
  if (glow) return glow;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.3, "rgba(255,255,255,.4)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  glow = new THREE.CanvasTexture(canvas);
  return glow;
}

/** Floor height under a point, from the space's surfaces, else the point itself. */
export function floorBelow(point: THREE.Vector3, surfaces: THREE.Object3D[], fallback: number) {
  if (!surfaces.length) return fallback;
  const ray = new THREE.Raycaster(point.clone().add(new THREE.Vector3(0, 0.5, 0)), new THREE.Vector3(0, -1, 0), 0, 30);
  const hit = ray.intersectObjects(surfaces, true)[0];
  return hit ? hit.point.y : fallback;
}

export const PALETTES: Record<string, string[]> = {
  party: ["#ff4f6d", "#ffd23f", "#3ec1d3", "#7bd389", "#b388eb", "#ff9f1c"],
  gold: ["#ffd700", "#f5c542", "#ffe8a3", "#c9a227", "#fff4cf"],
  nasa: ["#e03c31", "#111111", "#ffffff", "#f2efe6", "#0098db"],
  pastel: ["#ffd6e0", "#c1f0f6", "#fff1b8", "#d4f7c5", "#e2d4ff"]
};
