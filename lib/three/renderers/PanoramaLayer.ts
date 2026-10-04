import * as THREE from "three";
import type { NodeData } from "@/lib/types";
import { eulerFromLike } from "@/lib/three/math";
import { nodeCubeFaceUrl, nodePanoramaUrl } from "@/lib/media";
import { TextureCache } from "@/lib/three/TextureCache";

type PanoObject = {
  node: NodeData;
  group: THREE.Group;
  materials: THREE.Material[];
  urls: string[];
};

const FACE_ROTATIONS: [number, number, number][] = [
  [Math.PI / 2, 0, Math.PI],
  [0, Math.PI, 0],
  [0, Math.PI / 2, 0],
  [0, 0, 0],
  [0, -Math.PI / 2, 0],
  [-Math.PI / 2, 0, Math.PI]
];

const FACE_POSITIONS: [number, number, number][] = [
  [0, 100, 0],
  [0, 0, 100],
  [-100, 0, 0],
  [0, 0, -100],
  [100, 0, 0],
  [0, -100, 0]
];

function applyProductionCubeRotation(group: THREE.Group, node: NodeData) {
  if (node.quaternion) { group.quaternion.fromArray(node.quaternion); return; }
  const rotation = eulerFromLike(node.rotation);
  const nodeQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation.x, -rotation.y, rotation.z));
  const cubeBasisQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI, "XYZ"));
  group.quaternion.copy(nodeQuaternion.multiply(cubeBasisQuaternion));
}

/**
 * World direction of a pixel in a node's panorama image, measured from the
 * top-left corner as fractions (0..1). Cube faces use the same plane
 * transforms the layer renders with, so agents can point at what they see.
 */
export function panoramaPixelDirection(node: NodeData, x: number, y: number, face?: number) {
  const cube = face !== undefined && (node.faces?.length || node.cubeFaces?.length || node.textureTemplate);
  if (!cube) {
    const phi = x * Math.PI * 2;
    const theta = y * Math.PI;
    const direction = new THREE.Vector3(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
    return direction.applyEuler(eulerFromLike(node.rotation)).normalize();
  }
  const index = THREE.MathUtils.clamp(Math.round(face), 0, 5);
  const plane = new THREE.Object3D();
  plane.rotation.set(...FACE_ROTATIONS[index]);
  plane.position.set(...FACE_POSITIONS[index]);
  plane.updateMatrix();
  const group = new THREE.Group();
  applyProductionCubeRotation(group, node);
  const point = new THREE.Vector3((x - 0.5) * 200, (0.5 - y) * 200, 0).applyMatrix4(plane.matrix);
  return point.applyQuaternion(group.quaternion).normalize();
}

/**
 * Uniforms shared by every panorama material, so effects can restyle the
 * photographs: a pencil sketch from the photo's own edges, revealed or hidden
 * in a widening circle around a direction, and a scan that darkens the photo
 * ahead of a glowing front opening around another direction.
 */
export type PanoramaStyle = {
  uSketch: { value: number };
  uInk: { value: THREE.Color };
  uPaper: { value: THREE.Color };
  uRevealDirection: { value: THREE.Vector3 };
  uSketchAngle: { value: number };
  uColorAngle: { value: number };
  uAngleWidth: { value: number };
  uInvert: { value: number };
  uScanDim: { value: number };
  uScanGlow: { value: number };
  uScanColor: { value: THREE.Color };
  uScanDirection: { value: THREE.Vector3 };
  uScanAngle: { value: number };
  /** Looks: how far a drawn version of the photographs has replaced them, and how it arrives. */
  uVariantAmount: { value: number };
  uVariantMode: { value: number };
  uVariantDirection: { value: THREE.Vector3 };
  uVariantResolution: { value: THREE.Vector2 };
  /** Tour skies: how much of the photographs' own sky is cut away, and the light the photographs take on. */
  uSkyAmount: { value: number };
  uSkyLight: { value: THREE.Color };
};

/** Line-drawn (or watercolor) versions of a space's panorama faces, made offline. */
type VariantManifest = {
  styles: Record<string, string>;
  nodes: string[];
  /** Sky outlines (scripts/skies/masks.py): one digit per face, 0 no sky, 1 part (a mask file), 2 all sky. */
  sky?: { template: string; nodes: Record<string, string> };
};
type PanoVariant = { urls: string[]; ready: boolean };
type SkyUniforms = { uSkyMap: { value: THREE.Texture | null }; uSkyFace: { value: number } };

const STYLE_VERTEX = /* glsl */ `
  #include <project_vertex>
  vPanoDirection = (modelMatrix * vec4(transformed, 1.0)).xyz - cameraPosition;
`;

const STYLE_FRAGMENT = /* glsl */ `
  #include <map_fragment>
  if (uSketch > 0.001) {
    vec2 texel = uTexel;
    float tl = dot(texture2D(map, vMapUv + vec2(-texel.x, texel.y)).rgb, vec3(0.299, 0.587, 0.114));
    float tc = dot(texture2D(map, vMapUv + vec2(0.0, texel.y)).rgb, vec3(0.299, 0.587, 0.114));
    float tr = dot(texture2D(map, vMapUv + vec2(texel.x, texel.y)).rgb, vec3(0.299, 0.587, 0.114));
    float ml = dot(texture2D(map, vMapUv + vec2(-texel.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
    float mr = dot(texture2D(map, vMapUv + vec2(texel.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
    float bl = dot(texture2D(map, vMapUv + vec2(-texel.x, -texel.y)).rgb, vec3(0.299, 0.587, 0.114));
    float bc = dot(texture2D(map, vMapUv + vec2(0.0, -texel.y)).rgb, vec3(0.299, 0.587, 0.114));
    float br = dot(texture2D(map, vMapUv + vec2(texel.x, -texel.y)).rgb, vec3(0.299, 0.587, 0.114));
    float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
    float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
    float edge = smoothstep(0.12, 0.42, length(vec2(gx, gy)));
    float luminance = dot(sampledDiffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    float shade = 1.0 - smoothstep(0.03, 0.32, luminance);
    float diagonal = step(0.74, fract((gl_FragCoord.x - gl_FragCoord.y) / 6.0));
    float crossing = step(0.78, fract((gl_FragCoord.x + gl_FragCoord.y) / 7.0));
    float ink = clamp(edge + diagonal * smoothstep(0.35, 0.7, shade) * 0.5 + crossing * smoothstep(0.75, 0.95, shade) * 0.55, 0.0, 1.0);
    vec3 drawing = mix(uPaper, uInk, ink);
    float angle = acos(clamp(dot(normalize(vPanoDirection), uRevealDirection), -1.0, 1.0));
    float grain = (fract(sin(dot(floor(vMapUv * 90.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * uAngleWidth;
    float colored = 1.0 - smoothstep(uColorAngle - uAngleWidth, uColorAngle, angle + grain);
    colored = mix(colored, 1.0 - colored, uInvert);
    float drawn = 1.0 - smoothstep(uSketchAngle - uAngleWidth, uSketchAngle, angle + grain);
    vec3 page = mix(uPaper, drawing, drawn);
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(page, diffuseColor.rgb, colored), uSketch);
  }
  if (uScanDim + uScanGlow > 0.001) {
    float scanAngle = acos(clamp(dot(normalize(vPanoDirection), uScanDirection), -1.0, 1.0));
    float scanAhead = smoothstep(uScanAngle - 0.06, uScanAngle + 0.03, scanAngle);
    float scanFront = 1.0 - smoothstep(0.0, 0.07, abs(scanAngle - uScanAngle));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.1, scanAhead * uScanDim) + uScanColor * scanFront * uScanGlow;
  }
  if (uVariantAmount > 0.001 && uHasVariantMap > 0.5) {
    vec3 drawn = texture2D(uVariantMap, vMapUv).rgb;
    float shown = uVariantAmount;
    if (uVariantMode < 0.5) shown = step(0.5, uVariantAmount);
    else if (uVariantMode < 1.5) shown = uVariantAmount;
    else if (uVariantMode < 2.5) shown = step(fract(sin(dot(floor(gl_FragCoord.xy / 3.0), vec2(12.9898, 78.233))) * 43758.5453), uVariantAmount);
    else if (uVariantMode < 3.5) shown = 1.0 - smoothstep(uVariantAmount * 1.2 - 0.11, uVariantAmount * 1.2 - 0.09, gl_FragCoord.x / uVariantResolution.x);
    else if (uVariantMode < 5.5) {
      float variantAngle = acos(clamp(dot(normalize(vPanoDirection), uVariantDirection), -1.0, 1.0));
      shown = 1.0 - smoothstep(uVariantAmount * 3.5 - 0.13, uVariantAmount * 3.5 - 0.07, variantAngle);
    } else shown = step(fract(sin(dot(floor(gl_FragCoord.xy / (uVariantResolution / vec2(14.0, 30.0))), vec2(12.9898, 78.233))) * 43758.5453), uVariantAmount);
    diffuseColor.rgb = mix(diffuseColor.rgb, drawn, shown);
  }
  diffuseColor.rgb *= uSkyLight;
  if (uSkyAmount > 0.001 && uSkyFace > 0.5) {
    // Masks decode as sRGB like the photographs; undo that for the edge's share of sky.
    float skyShare = uSkyFace > 1.5 ? 1.0 : pow(texture2D(uSkyMap, vMapUv).r, 0.4545);
    diffuseColor.a *= 1.0 - skyShare * uSkyAmount;
  }
`;

function stylable(material: THREE.MeshBasicMaterial, style: PanoramaStyle, texture: THREE.Texture | null) {
  const image = texture?.image as { width?: number; height?: number } | undefined;
  const texel = new THREE.Vector2(1 / Math.max(256, image?.width ?? 1024), 1 / Math.max(256, image?.height ?? 1024));
  // Each face has its own drawn version, so this material keeps its own sampler.
  const variant = { uVariantMap: { value: null as THREE.Texture | null }, uHasVariantMap: { value: 0 } };
  material.userData.variant = variant;
  const sky: SkyUniforms = { uSkyMap: { value: null }, uSkyFace: { value: 0 } };
  material.userData.sky = sky;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, style, { uTexel: { value: texel } }, variant, sky);
    shader.vertexShader = "varying vec3 vPanoDirection;\n" + shader.vertexShader.replace("#include <project_vertex>", STYLE_VERTEX);
    shader.fragmentShader = `uniform float uSketch; uniform vec3 uInk; uniform vec3 uPaper; uniform vec3 uRevealDirection;
      uniform float uSketchAngle; uniform float uColorAngle; uniform float uAngleWidth; uniform float uInvert; uniform vec2 uTexel;
      uniform float uScanDim; uniform float uScanGlow; uniform vec3 uScanColor; uniform vec3 uScanDirection; uniform float uScanAngle;
      uniform float uVariantAmount; uniform float uVariantMode; uniform vec3 uVariantDirection; uniform vec2 uVariantResolution;
      uniform sampler2D uVariantMap; uniform float uHasVariantMap;
      uniform float uSkyAmount; uniform vec3 uSkyLight; uniform sampler2D uSkyMap; uniform float uSkyFace;
      varying vec3 vPanoDirection;\n` + shader.fragmentShader.replace("#include <map_fragment>", STYLE_FRAGMENT);
  };
  material.customProgramCacheKey = () => "sphr-panorama-style-v4";
  return material;
}

export class PanoramaLayer {
  readonly style: PanoramaStyle = {
    uSketch: { value: 0 },
    uInk: { value: new THREE.Color("#2b2a27") },
    uPaper: { value: new THREE.Color("#f2efe6") },
    uRevealDirection: { value: new THREE.Vector3(0, 0, -1) },
    uSketchAngle: { value: 4 },
    uColorAngle: { value: 0 },
    uAngleWidth: { value: 0.12 },
    uInvert: { value: 0 },
    uScanDim: { value: 0 },
    uScanGlow: { value: 0 },
    uScanColor: { value: new THREE.Color("#7fd6ff") },
    uScanDirection: { value: new THREE.Vector3(0, -1, 0) },
    uScanAngle: { value: 0 },
    uVariantAmount: { value: 0 },
    uVariantMode: { value: 1 },
    uVariantDirection: { value: new THREE.Vector3(0, -1, 0) },
    uVariantResolution: { value: new THREE.Vector2(1, 1) },
    uSkyAmount: { value: 0 },
    uSkyLight: { value: new THREE.Color(1, 1, 1) }
  };
  private variantSource: string | null = null;
  private manifest: Promise<VariantManifest | null> | null = null;
  private variantTemplate: string | null = null;
  private variantNodes = new Set<string>();
  private readonly panoVariants = new WeakMap<PanoObject, PanoVariant>();
  private skyWanted = false;
  private skyOutlines: VariantManifest["sky"] | null = null;
  private readonly panoSkies = new WeakMap<PanoObject, string[]>();

  private active: PanoObject | null = null;
  private outgoing: PanoObject | null = null;
  private transitionCapture: PanoObject | null = null;
  private transitionScene: THREE.Scene | null = null;
  private visible = true;
  private presentationOpacity = 1;
  private disposed = false;
  private fade: { start: number; duration: number; fadeStart: number } | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly textureCache: TextureCache,
    private readonly version?: string | null
  ) {}

  private urls(node: NodeData) {
    return node.image && !(node.faces?.length || node.cubeFaces?.length || node.textureTemplate)
      ? [nodePanoramaUrl(node, "full")]
      : Array.from({ length: 6 }, (_, face) => nodeCubeFaceUrl(node, face, "1024", this.version));
  }

  async prepare(node: NodeData) {
    const urls = this.urls(node);
    this.textureCache.retain(urls);
    try { await Promise.all(urls.map((url) => this.textureCache.loadAsync(url))); }
    finally { this.textureCache.release(urls, false); }
  }

  async loadInitial(node?: NodeData | null) {
    if (!node) return;
    await this.prepare(node);
    if (this.disposed) return;
    this.active = this.createPano(node, 1);
    this.scene.add(this.active.group);
  }

  navigate(node: NodeData, duration = 700, options: { replaceImmediately?: boolean; fadeStart?: number } = {}) {
    if (this.disposed || this.active?.node.uuid === node.uuid) return;
    if (this.outgoing) { this.scene.remove(this.outgoing.group); this.disposeObject(this.outgoing); }
    this.outgoing = this.active;
    if (this.outgoing) {
      this.setOpacity(this.outgoing, 1);
      this.outgoing.group.traverse((mesh) => { mesh.renderOrder = -20; });
    }
    if (options.replaceImmediately && this.outgoing) {
      this.scene.remove(this.outgoing.group);
      this.disposeObject(this.outgoing);
      this.outgoing = null;
    }
    this.active = this.createPano(node, options.replaceImmediately ? 1 : 0);
    this.active.group.visible = this.visible;
    this.scene.add(this.active.group);
    this.fade = options.replaceImmediately ? null : {
      start: performance.now(), duration: Math.max(1, duration),
      fadeStart: THREE.MathUtils.clamp(options.fadeStart ?? 0, 0, 0.99)
    };
  }

  update(camera: THREE.Camera) {
    this.active?.group.position.copy(camera.position);
    this.outgoing?.group.position.copy(camera.position);
    if (!this.fade) return;
    const progress = this.fadeProgress();
    this.setOpacity(this.active, progress);
    if (progress === 1) {
      if (this.outgoing) { this.scene.remove(this.outgoing.group); this.disposeObject(this.outgoing); this.outgoing = null; }
      this.fade = null;
    }
  }

  getDebugSnapshot() {
    return {
      activeNode: this.active?.node.uuid, outgoingNode: this.outgoing?.node.uuid,
      fading: Boolean(this.fade), visible: this.visible, incomingOpacity: this.fadeProgress() * this.presentationOpacity
    };
  }

  private fadeProgress() {
    if (!this.fade) return 1;
    const elapsed = (performance.now() - this.fade.start) / this.fade.duration;
    return THREE.MathUtils.clamp((elapsed - this.fade.fadeStart) / (1 - this.fade.fadeStart), 0, 1);
  }

  prepareTransitionCapture(scene: THREE.Scene, node: NodeData, position: THREE.Vector3) {
    this.clearTransitionCapture();
    this.transitionScene = scene;
    this.transitionCapture = this.createPano(node, 1);
    this.transitionCapture.group.name = `panorama-transition-capture-${node.uuid}`;
    this.transitionCapture.group.position.copy(position);
    scene.add(this.transitionCapture.group);
  }

  updateTransitionCapture(position: THREE.Vector3) {
    this.transitionCapture?.group.position.copy(position);
  }

  clearTransitionCapture() {
    if (!this.transitionCapture) return;
    this.transitionScene?.remove(this.transitionCapture.group);
    this.disposeObject(this.transitionCapture);
    this.transitionCapture = null;
    this.transitionScene = null;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (this.active) this.active.group.visible = visible;
    if (this.outgoing) this.outgoing.group.visible = visible;
  }

  setPresentationOpacity(opacity: number) {
    this.presentationOpacity = THREE.MathUtils.clamp(opacity, 0, 1);
    const progress = this.fadeProgress();
    this.setOpacity(this.active, progress);
    this.setOpacity(this.outgoing, 1);
  }

  dispose() {
    this.disposed = true;
    this.fade = null;
    this.clearTransitionCapture();
    [this.active, this.outgoing].forEach((object) => {
      if (!object) return;
      this.scene.remove(object.group);
      this.disposeObject(object);
    });
    this.active = null;
    this.outgoing = null;
  }

  private createPano(node: NodeData, opacity: number): PanoObject {
    const group = new THREE.Group();
    group.name = `panorama-${node.uuid}`;
    const urls = this.urls(node);
    this.textureCache.retain(urls);

    if (node.image && !(node.faces?.length || node.cubeFaces?.length || node.textureTemplate)) {
      const texture = this.textureCache.getReady(urls[0]);
      const material = stylable(new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.BackSide,
        transparent: true,
        opacity,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        depthTest: false
      }), this.style, texture);
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 40), material);
      sphere.renderOrder = -10;
      sphere.rotation.copy(eulerFromLike(node.rotation));
      group.add(sphere);
      // Drawn versions exist for cube faces only.
      return { node, group, materials: [material], urls };
    }

    const materials: THREE.Material[] = [];
    for (let face = 0; face < 6; face += 1) {
      const texture = this.textureCache.getReady(urls[face]);
      const material = stylable(new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        depthTest: false
      }), this.style, texture);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), material);
      mesh.rotation.set(...FACE_ROTATIONS[face]);
      mesh.position.set(...FACE_POSITIONS[face]);
      mesh.renderOrder = -10;
      group.add(mesh);
      materials.push(material);
    }
    applyProductionCubeRotation(group, node);
    const pano = { node, group, materials, urls };
    this.attachVariant(pano);
    this.attachSky(pano);
    return pano;
  }

  private setOpacity(object: PanoObject | null, opacity: number) {
    object?.materials.forEach((material) => {
      if ("opacity" in material) {
        material.opacity = opacity * this.presentationOpacity;

      }
    });
  }

  /** Where this space's drawn panorama faces are listed, if anywhere. */
  setVariantSource(url: string | null | undefined) {
    if ((url ?? null) === this.variantSource) return;
    this.variantSource = url ?? null;
    this.manifest = null;
  }

  /**
   * Load the drawn version of the photographs ("sketch" uses the line drawings),
   * starting with the faces in view; resolves to whether this space has it.
   */
  async prepareVariant(kind: "sketch" | "watercolor") {
    if (!this.variantSource) return false;
    this.manifest ??= fetch(this.variantSource, { credentials: "omit" }).then((response) => response.ok ? response.json() as Promise<VariantManifest> : null).catch(() => null);
    const manifest = await this.manifest;
    const template = manifest?.styles?.[kind === "sketch" ? "contour" : "watercolor"] ?? (kind === "sketch" ? manifest?.styles?.anime : undefined);
    if (!manifest || typeof template !== "string" || !/^https:\/\//.test(template) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(template)) return false;
    if (template !== this.variantTemplate) {
      this.variantTemplate = template;
      this.variantNodes = new Set(Array.isArray(manifest.nodes) ? manifest.nodes : []);
      for (const pano of [this.active, this.outgoing, this.transitionCapture]) if (pano) this.attachVariant(pano, true);
    }
    const active = this.active && this.panoVariants.get(this.active);
    if (active && !active.ready) await Promise.all(active.urls.map((url) => this.textureCache.loadAsync(url).catch(() => null)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return true;
  }

  /** Whether the location in view has its drawn faces loaded. */
  variantReady() {
    const variant = this.active && this.panoVariants.get(this.active);
    return Boolean(variant?.ready);
  }

  /** Blend the photographs toward their drawn version, revealed the way a look's transition says. */
  showVariant(amount: number, mode: number, direction: THREE.Vector3, resolution: THREE.Vector2) {
    this.style.uVariantAmount.value = this.variantTemplate ? amount : 0;
    this.style.uVariantMode.value = mode;
    this.style.uVariantDirection.value.copy(direction);
    this.style.uVariantResolution.value.copy(resolution);
  }

  /**
   * A tour sky shows through the photographs where they see sky (by `amount`), and the
   * photographs take on its light. Sky outlines load the first time a sky is used.
   */
  setSky(amount: number, light: THREE.Color) {
    this.style.uSkyAmount.value = amount;
    this.style.uSkyLight.value.copy(light);
    if (amount > 0 && !this.skyWanted) {
      this.skyWanted = true;
      void this.prepareSky();
    }
  }

  /** Whether this space's photographs have sky outlines, so a tour sky can show through them. */
  async hasSkyOutlines() {
    await this.loadSkyOutlines();
    return Boolean(this.skyOutlines && Object.keys(this.skyOutlines.nodes).length);
  }

  private async loadSkyOutlines() {
    if (!this.variantSource) return;
    this.manifest ??= fetch(this.variantSource, { credentials: "omit" }).then((response) => response.ok ? response.json() as Promise<VariantManifest> : null).catch(() => null);
    const sky = (await this.manifest)?.sky;
    const template = sky?.template;
    const safe = typeof template === "string" && (/^https:\/\//.test(template) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(template));
    this.skyOutlines = safe && sky?.nodes && typeof sky.nodes === "object" ? sky : null;
  }

  private async prepareSky() {
    await this.loadSkyOutlines();
    if (this.disposed) return;
    for (const pano of [this.active, this.outgoing, this.transitionCapture]) if (pano) this.attachSky(pano);
  }

  private attachSky(pano: PanoObject) {
    const outlines = this.skyOutlines;
    if (!this.skyWanted || !outlines || pano.materials.length !== 6 || this.panoSkies.has(pano)) return;
    const codes = outlines.nodes[pano.node.uuid];
    if (typeof codes !== "string") return;
    const urls: string[] = [];
    this.panoSkies.set(pano, urls);
    pano.materials.forEach((material, face) => {
      const uniforms = material.userData.sky as SkyUniforms | undefined;
      if (!uniforms) return;
      if (codes[face] === "2") { uniforms.uSkyFace.value = 2; return; }
      if (codes[face] !== "1") return;
      const url = outlines.template.replace("{uuid}", encodeURIComponent(pano.node.uuid)).replace("{face}", String(face));
      urls.push(url);
      this.textureCache.retain([url]);
      void this.textureCache.loadAsync(url).then((texture) => {
        if (this.panoSkies.get(pano) !== urls) return;
        uniforms.uSkyMap.value = texture;
        uniforms.uSkyFace.value = 1;
      }, () => { /* without its outline this face keeps its own sky */ });
    });
  }

  private attachVariant(pano: PanoObject, replace = false) {
    if (!this.variantTemplate || pano.materials.length !== 6 || !this.variantNodes.has(pano.node.uuid)) return;
    const existing = this.panoVariants.get(pano);
    if (existing && !replace) return;
    if (existing) this.textureCache.release(existing.urls, false);
    const template = this.variantTemplate;
    const urls = Array.from({ length: 6 }, (_, face) => template.replace("{uuid}", encodeURIComponent(pano.node.uuid)).replace("{face}", String(face)));
    const variant: PanoVariant = { urls, ready: false };
    this.panoVariants.set(pano, variant);
    this.textureCache.retain(urls);
    void Promise.all(urls.map((url) => this.textureCache.loadAsync(url))).then((textures) => {
      if (this.panoVariants.get(pano) !== variant) return;
      textures.forEach((texture, face) => {
        const uniforms = pano.materials[face].userData.variant as { uVariantMap: { value: THREE.Texture | null }; uHasVariantMap: { value: number } };
        uniforms.uVariantMap.value = texture;
        uniforms.uHasVariantMap.value = 1;
      });
      variant.ready = true;
    }, (error) => console.warn("Unable to load the drawn version of this panorama", error));
  }

  private disposeObject(object: PanoObject) {
    const skies = this.panoSkies.get(object);
    if (skies) { this.textureCache.release(skies, false); this.panoSkies.delete(object); }
    const variant = this.panoVariants.get(object);
    if (variant) { this.textureCache.release(variant.urls, false); this.panoVariants.delete(object); }
    this.textureCache.release(object.urls);
    object.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
    });
    object.materials.forEach((material) => material.dispose());
  }
}
