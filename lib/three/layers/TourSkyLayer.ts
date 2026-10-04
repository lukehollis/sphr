import * as THREE from "three";
import { skyEntry } from "@/lib/experience/packs";
import type { SkyMeta } from "@/lib/experience/registry";
import { SKY_RANGES, type StopSky } from "@/lib/experience/types";

/**
 * A tour's sky: a photograph (or a drawn gradient) on a sphere far behind the
 * space, faded from one sky to the next as stops change. The space takes on the
 * sky's light through `light()`, and 360 photos let it through where they show
 * sky (PanoramaLayer cuts their sky out by `amount`).
 */

type Slot = {
  key: string;
  /** 1 for a sky, 0 for none (the capture's own sky). */
  shown: number;
  texture: THREE.Texture | null;
  gradient: SkyMeta["gradient"] | null;
  turn: number;
  brightness: number;
  /** The space's color under this sky, light amount included. */
  tint: THREE.Color;
  /** Where its sun or moon is, already turned; null without one. */
  sun: THREE.Vector3 | null;
};

const NONE_KEY = "none";
const WHITE = new THREE.Color(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

function skyKey(sky: StopSky | null | undefined) {
  if (!sky || sky.sky === NONE_KEY) return NONE_KEY;
  return JSON.stringify([sky.sky, sky.url ?? "", sky.turn ?? 0, sky.brightness ?? 1, sky.light ?? 1]);
}

/** Direction of a point in an equirectangular image (fractions from the left and top), as the shader samples it. */
export function skyImageDirection(x: number, y: number, turnDegrees = 0) {
  const longitude = (x - 0.5) * Math.PI * 2;
  const latitude = (0.5 - y) * Math.PI;
  return new THREE.Vector3(Math.cos(latitude) * Math.cos(longitude), Math.sin(latitude), Math.cos(latitude) * Math.sin(longitude))
    .applyAxisAngle(UP, THREE.MathUtils.degToRad(turnDegrees));
}

/**
 * The light a space should take on under a sky of the customer's own, from the image
 * itself (skies from the packs carry theirs): the sky's mean color eased toward white,
 * dimmed for a dark sky, so their night sky darkens the space like the library's do.
 */
export function estimateSkyLight(image: CanvasImageSource) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return WHITE.clone();
    context.drawImage(image, 0, 0, 64, 32);
    const pixels = context.getImageData(0, 0, 64, 16).data; // the upper half, the sky itself
    const linear = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const mean = [0, 0, 0];
    let weight = 0;
    for (let y = 0; y < 16; y += 1) {
      const share = Math.sin(((y + 0.5) / 16) * Math.PI / 2); // rows near the zenith cover less of the sky
      for (let x = 0; x < 64; x += 1) {
        const index = (y * 64 + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) mean[channel] += linear(pixels[index + channel]) * share;
        weight += share;
      }
    }
    const [r, g, b] = mean.map((value) => value / weight);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const level = THREE.MathUtils.clamp(Math.sqrt(luminance / 0.22), 0.42, 1);
    const top = Math.max(r, g, b, 1e-6);
    // Dark skies read as moonlight; bright ones keep most of the daylight white.
    const hue = level < 0.6 ? new THREE.Color(0.5, 0.62, 1) : new THREE.Color(r / top, g / top, b / top);
    return WHITE.clone().lerp(hue, level < 0.6 ? 0.9 : 0.2).multiplyScalar(level);
  } catch {
    return WHITE.clone();
  }
}

const VERTEX = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = position;
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // On the far plane, so everything in the space draws in front of it.
    gl_Position = clip.xyww;
  }
`;

const SLOT_UNIFORMS = (name: string) => /* glsl */ `
  uniform sampler2D uMap${name}; uniform float uHasMap${name};
  uniform vec3 uZenith${name}; uniform vec3 uHorizon${name}; uniform vec3 uGround${name};
  uniform vec3 uSunDirection${name}; uniform vec3 uSunColor${name}; uniform float uSunSize${name}; uniform float uStars${name};
  uniform float uTurn${name}; uniform float uBrightness${name}; uniform float uShown${name};
`;

const FRAGMENT = /* glsl */ `
  #include <common>
  ${SLOT_UNIFORMS("A")}
  ${SLOT_UNIFORMS("B")}
  uniform float uMix;
  varying vec3 vDirection;

  float skyHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }

  vec3 turnAround(vec3 d, float angle) {
    float c = cos(angle), s = sin(angle);
    return vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z);
  }

  vec3 imageSky(sampler2D map, vec3 d) {
    vec2 uv = vec2(atan(d.z, d.x) * RECIPROCAL_PI2 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5);
    // The seam where longitude wraps would pick the smallest mip; take derivatives across it.
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    dx.x -= floor(dx.x + 0.5);
    dy.x -= floor(dy.x + 0.5);
    return textureGrad(map, uv, dx, dy).rgb;
  }

  vec3 drawnSky(vec3 d, vec3 zenith, vec3 horizon, vec3 ground, vec3 sunDirection, vec3 sunColor, float sunSize, float stars) {
    vec3 color = d.y >= 0.0
      ? mix(horizon, zenith, pow(clamp(d.y, 0.0, 1.0), 0.55))
      : mix(horizon, ground, smoothstep(0.0, 0.2, -d.y));
    if (sunSize > 0.0) {
      float away = acos(clamp(dot(d, sunDirection), -1.0, 1.0));
      color += sunColor * (smoothstep(sunSize, sunSize * 0.75, away) * 3.0 + exp(-away / (sunSize * 5.0)) * 0.45);
    }
    if (stars > 0.0 && d.y > 0.0) {
      vec3 p = d * 260.0;
      vec3 cell = floor(p);
      float seed = skyHash(cell);
      vec3 offset = fract(p) - 0.5 - (vec3(skyHash(cell + 1.7), skyHash(cell + 3.1), skyHash(cell + 5.3)) - 0.5) * 0.6;
      float star = step(1.0 - 0.012 * stars, seed) * smoothstep(0.16, 0.0, length(offset));
      color += vec3(0.85, 0.9, 1.0) * star * (0.4 + 0.6 * skyHash(cell + 9.1)) * smoothstep(0.0, 0.25, d.y);
    }
    return color;
  }

  vec3 slotA(vec3 d) {
    vec3 turned = turnAround(d, -uTurnA);
    vec3 color = uHasMapA > 0.5 ? imageSky(uMapA, turned) : drawnSky(turned, uZenithA, uHorizonA, uGroundA, uSunDirectionA, uSunColorA, uSunSizeA, uStarsA);
    return color * uBrightnessA;
  }

  vec3 slotB(vec3 d) {
    vec3 turned = turnAround(d, -uTurnB);
    vec3 color = uHasMapB > 0.5 ? imageSky(uMapB, turned) : drawnSky(turned, uZenithB, uHorizonB, uGroundB, uSunDirectionB, uSunColorB, uSunSizeB, uStarsB);
    return color * uBrightnessB;
  }

  void main() {
    vec3 d = normalize(vDirection);
    float a = uShownA * (1.0 - uMix);
    float b = uShownB * uMix;
    float alpha = a + b;
    if (alpha < 0.001) discard;
    vec3 color = vec3(0.0);
    if (a > 0.0) color += slotA(d) * a;
    if (b > 0.0) color += slotB(d) * b;
    gl_FragColor = vec4(color / alpha, alpha);
    #include <colorspace_fragment>
  }
`;

function slotUniforms() {
  return {
    uMap: { value: null as THREE.Texture | null }, uHasMap: { value: 0 },
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
    uSunDirection: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() }, uSunSize: { value: 0 }, uStars: { value: 0 },
    uTurn: { value: 0 }, uBrightness: { value: 1 }, uShown: { value: 0 }
  };
}

type SlotUniforms = ReturnType<typeof slotUniforms>;

export class TourSkyLayer {
  private readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly uniformsA = slotUniforms();
  private readonly uniformsB = slotUniforms();
  private readonly loader = new THREE.TextureLoader();
  private readonly textures = new Map<string, { texture: Promise<THREE.Texture | null>; loaded: THREE.Texture | null; used: number }>();
  /** A is the sky faded from, B the sky faded to. */
  private from: Slot = this.none();
  private to: Slot = this.none();
  private progress = 1;
  private duration = 0;
  private requested = NONE_KEY;
  private sequence = 0;
  private readonly tint = new THREE.Color(1, 1, 1);
  private readonly sunDirection = new THREE.Vector3();
  private changed = true;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, private readonly maxTextureSize: number) {
    const uniforms: Record<string, { value: unknown }> = { uMix: { value: 1 } };
    for (const [key, value] of Object.entries(this.uniformsA)) uniforms[`${key}A`] = value;
    for (const [key, value] of Object.entries(this.uniformsB)) uniforms[`${key}B`] = value;
    const material = new THREE.ShaderMaterial({
      uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT,
      side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: true, fog: false, toneMapped: false
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 64, 32), material);
    this.mesh.name = "tour-sky";
    // First among see-through things: splats, 360 photos and the map draw over it.
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** How much of a tour sky shows (0 is the capture's own sky), for 360 photos to cut theirs. */
  get amount() {
    return this.from.shown * (1 - this.progress) + this.to.shown * this.progress;
  }

  /** The sky the tour wants now, even while its image is still loading. */
  get current() { return this.requested; }

  /**
   * Fade to a sky (or to none) over its duration. A sky from a pack shows its small
   * preview at once and sharpens when the full image arrives.
   */
  set(sky: StopSky | null | undefined, { instant = false } = {}) {
    const key = skyKey(sky);
    if (key === this.requested) return;
    this.requested = key;
    const token = ++this.sequence;
    void this.slotFor(sky, key).then((slot) => {
      if (this.disposed || token !== this.sequence || !slot) return;
      // Start from what shows now: the blend so far becomes the sky faded from.
      this.from = this.progress >= 0.5 ? this.to : this.from;
      this.to = slot;
      this.progress = instant ? 1 : 0;
      this.duration = instant ? 0 : Math.max(0, sky?.duration ?? SKY_RANGES.duration.default);
      if (this.duration === 0) this.progress = 1;
      this.applySlot(this.uniformsA, this.from);
      this.applySlot(this.uniformsB, this.to);
      this.changed = true;
    });
  }

  /** Follows the camera and advances the fade; returns whether the space's light changed. */
  update(camera: THREE.Camera, delta: number) {
    this.mesh.position.copy(camera.position);
    if (this.progress < 1) {
      this.progress = Math.min(1, this.progress + delta / Math.max(0.01, this.duration));
      this.changed = true;
    }
    const eased = this.progress * this.progress * (3 - 2 * this.progress);
    this.mesh.material.uniforms.uMix.value = eased;
    this.mesh.visible = this.amount > 0.001;
    if (!this.changed) return false;
    this.changed = false;
    this.tint.copy(this.from.tint).lerp(this.to.tint, eased);
    return true;
  }

  /** The color the space is multiplied by under the sky now (white without one). */
  light() { return this.tint; }

  /** Where the light comes from under the sky now, if it has a sun or moon. */
  sun(): THREE.Vector3 | null {
    const slot = this.progress >= 0.5 ? this.to : this.from;
    return slot.sun ? this.sunDirection.copy(slot.sun) : null;
  }

  getDebugSnapshot() {
    return { requested: this.requested, from: this.from.key, to: this.to.key, progress: Number(this.progress.toFixed(3)), amount: Number(this.amount.toFixed(3)), light: `#${this.tint.getHexString()}`, visible: this.mesh.visible };
  }

  dispose() {
    this.disposed = true;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    for (const entry of this.textures.values()) entry.loaded?.dispose();
    this.textures.clear();
  }

  private none(): Slot {
    return { key: NONE_KEY, shown: 0, texture: null, gradient: null, turn: 0, brightness: 1, tint: WHITE.clone(), sun: null };
  }

  private async slotFor(sky: StopSky | null | undefined, key: string): Promise<Slot | null> {
    if (!sky || key === NONE_KEY) return this.none();
    const meta = sky.sky === "custom" ? null : skyEntry(sky.sky);
    if (sky.sky !== "custom" && !meta) return this.none();
    const turn = sky.turn ?? 0;
    const lightAmount = sky.light ?? SKY_RANGES.light.default;
    const tint = WHITE.clone().lerp(new THREE.Color(meta?.light ?? "#ffffff"), lightAmount);
    const slot: Slot = {
      key, shown: 1, texture: null, gradient: meta?.gradient ?? null, turn,
      brightness: sky.brightness ?? SKY_RANGES.brightness.default, tint,
      sun: meta?.sun ? skyImageDirection(meta.sun[0], meta.sun[1], turn) : null
    };
    const full = sky.sky === "custom" ? sky.url : meta?.image;
    if (!full) return slot;
    const preview = meta?.preview;
    const wanted = this.maxTextureSize >= 4096 || !preview ? full : preview;
    // Show the small preview first when the full image is not loaded yet.
    const quick = preview && preview !== wanted && !this.textures.get(wanted)?.loaded ? preview : wanted;
    slot.texture = await this.load(quick);
    if (!slot.texture && quick !== wanted) {
      slot.texture = await this.load(wanted);
      return slot.texture ? slot : null;
    }
    if (!slot.texture) return null;
    if (sky.sky === "custom" && slot.texture.image) slot.tint = WHITE.clone().lerp(estimateSkyLight(slot.texture.image as CanvasImageSource), lightAmount);
    if (quick !== wanted) {
      void this.load(wanted).then((texture) => {
        if (!texture || this.disposed) return;
        slot.texture = texture;
        if (this.to === slot) this.applySlot(this.uniformsB, slot);
        if (this.from === slot) this.applySlot(this.uniformsA, slot);
      });
    }
    return slot;
  }

  private load(url: string) {
    const cached = this.textures.get(url);
    if (cached) { cached.used = performance.now(); return cached.texture; }
    const entry = { texture: Promise.resolve(null as THREE.Texture | null), loaded: null as THREE.Texture | null, used: performance.now() };
    entry.texture = new Promise<THREE.Texture | null>((resolve) => {
      this.loader.setCrossOrigin("anonymous");
      this.loader.load(url, (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.RepeatWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = 4;
        entry.loaded = texture;
        resolve(texture);
      }, undefined, () => {
        console.warn("Unable to load this sky", url);
        this.textures.delete(url);
        resolve(null);
      });
    });
    this.textures.set(url, entry);
    this.evict();
    return entry.texture;
  }

  /** Keep the few skies a tour moves between; drop the oldest beyond that. */
  private evict() {
    if (this.textures.size <= 6) return;
    const inUse = new Set([this.from.texture, this.to.texture]);
    const oldest = [...this.textures.entries()].filter(([, entry]) => entry.loaded && !inUse.has(entry.loaded)).sort((a, b) => a[1].used - b[1].used)[0];
    if (!oldest) return;
    oldest[1].loaded?.dispose();
    this.textures.delete(oldest[0]);
  }

  private applySlot(uniforms: SlotUniforms, slot: Slot) {
    uniforms.uShown.value = slot.shown;
    uniforms.uMap.value = slot.texture;
    uniforms.uHasMap.value = slot.texture ? 1 : 0;
    uniforms.uTurn.value = THREE.MathUtils.degToRad(slot.turn);
    uniforms.uBrightness.value = slot.brightness;
    const gradient = slot.gradient;
    if (gradient) {
      uniforms.uZenith.value.set(gradient.zenith);
      uniforms.uHorizon.value.set(gradient.horizon);
      uniforms.uGround.value.set(gradient.ground);
      uniforms.uSunColor.value.set(gradient.sun?.color ?? "#000000");
      uniforms.uSunSize.value = gradient.sun?.size ?? 0;
      uniforms.uStars.value = gradient.stars ?? 0;
      // The drawn sun sits where the sky says, before the turn the shader applies.
      if (slot.sun) uniforms.uSunDirection.value.copy(slot.sun).applyAxisAngle(UP, -THREE.MathUtils.degToRad(slot.turn));
    } else {
      uniforms.uSunSize.value = 0;
      uniforms.uStars.value = 0;
    }
  }
}
