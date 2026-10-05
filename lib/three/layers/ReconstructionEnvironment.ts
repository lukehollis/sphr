import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import type { ReconstructionEnvironmentConfig } from "@/lib/types";

const QUAD_VERTEX = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * Daylight belongs to the reconstruction, not the captured photographs. Fog is
 * integrated through a real world-space volume, stopping at the visible depth.
 * The sun's depth map shadows both the stone and the dust between it and us.
 * Only the small scattering buffer is ray marched; the scene stays full size.
 */
export class ReconstructionEnvironment {
  private readonly root = new THREE.Group();
  private readonly sky = new Sky();
  private readonly sun = new THREE.DirectionalLight();
  private readonly fill = new THREE.HemisphereLight(0xbcd5ed, 0xa28c68, 0.3);
  private readonly sunDirection = new THREE.Vector3();
  private readonly worldToSite = new THREE.Matrix4();
  private readonly size = new THREE.Vector2();
  private readonly eye = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly localForward = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly previousFocus = new THREE.Vector3(Infinity, Infinity, Infinity);
  private previousExtent = 0;
  private readonly ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | null;
  private environmentMap: THREE.WebGLRenderTarget | null = null;
  private frame: THREE.WebGLRenderTarget | null = null;
  private volume: THREE.WebGLRenderTarget | null = null;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  private readonly scattering: THREE.ShaderMaterial;
  private readonly composite: THREE.ShaderMaterial;
  private amount = 0;
  private prepared = false;
  private compact = false;
  private floatTargets = false;

  constructor(private readonly scene: THREE.Scene, private readonly site: THREE.Group, private readonly config: ReconstructionEnvironmentConfig) {
    this.root.name = "reconstruction-environment";
    this.root.visible = false;
    this.root.matrixAutoUpdate = false;
    this.worldToSite.copy(site.matrixWorld).invert();
    this.root.matrix.copy(site.matrixWorld);
    const azimuth = THREE.MathUtils.degToRad(config.sun.azimuth);
    const elevation = THREE.MathUtils.degToRad(config.sun.elevation);
    this.sunDirection.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)).transformDirection(site.matrixWorld);
    this.sun.name = "reconstruction-sun";
    this.sun.color.set(config.sun.color);
    this.sun.castShadow = true;
    this.sun.shadow.autoUpdate = false;
    this.sun.shadow.bias = -0.00006;
    this.sun.shadow.normalBias = 0.18;
    this.sun.shadow.radius = 2;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 10000;
    // Lights are in world coordinates, ground in the site's local coordinates.
    this.scene.add(this.sun, this.sun.target, this.fill, this.root, this.sky);
    this.sun.visible = this.fill.visible = false;
    this.ground = config.ground ? createGround(config.ground) : null;
    if (this.ground) this.root.add(this.ground);
    this.sky.name = "reconstruction-daylight-sky";
    this.sky.scale.setScalar(20000);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.sky.visible = false;
    this.sky.material.transparent = true;
    this.sky.material.fog = false;
    const uniforms = this.sky.material.uniforms;
    uniforms.turbidity.value = config.sky.turbidity;
    uniforms.rayleigh.value = config.sky.rayleigh;
    uniforms.mieCoefficient.value = 0.006;
    uniforms.mieDirectionalG.value = 0.8;
    uniforms.sunPosition.value.copy(this.sunDirection);
    uniforms.cloudCoverage.value = config.sky.clouds;
    uniforms.cloudDensity.value = 0.3;
    uniforms.cloudSpeed.value = 0.00002;
    uniforms.opacity = { value: 0 };
    uniforms.hazeSun = { value: new THREE.Color(config.sun.color).multiplyScalar(config.fog.shafts * 0.12) };
    uniforms.hazeAnisotropy = { value: config.fog.anisotropy };
    uniforms.groundHaze = { value: new THREE.Color(config.fog.color).multiplyScalar(0.65).add(new THREE.Color(config.sun.color).multiplyScalar(0.22)) };
    this.sky.material.fragmentShader = this.sky.material.fragmentShader.replace("vec4( texColor, 1.0 )", "vec4( texColor, opacity )");
    this.sky.material.fragmentShader = "uniform float opacity; uniform vec3 groundHaze, hazeSun; uniform float hazeAnisotropy;\n" + this.sky.material.fragmentShader.replace(
      "gl_FragColor = vec4( texColor, opacity );",
      "float hazePhase = (1.0 - hazeAnisotropy * hazeAnisotropy) / pow(max(0.05, 1.0 + hazeAnisotropy * hazeAnisotropy - 2.0 * hazeAnisotropy * dot(direction, vSunDirection)), 1.5); texColor = mix(texColor, groundHaze + hazeSun * hazePhase, 1.0 - smoothstep(-0.01, 0.12, direction.y));\n gl_FragColor = vec4( texColor, opacity );"
    );
    this.scattering = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERTEX, fragmentShader: VOLUME_FRAGMENT, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        tDepth: { value: null }, tShadow: { value: null }, uShadowMatrix: { value: this.sun.shadow.matrix },
        uProjection: { value: new THREE.Matrix4() }, uProjectionInverse: { value: new THREE.Matrix4() }, uCameraMatrix: { value: new THREE.Matrix4() },
        uWorldToSite: { value: this.worldToSite }, uEye: { value: new THREE.Vector3() }, uSun: { value: this.sunDirection },
        uFogColor: { value: new THREE.Color(config.fog.color) }, uSunColor: { value: new THREE.Color(config.sun.color) },
        uDensity: { value: config.fog.density }, uHeight: { value: config.fog.height }, uGround: { value: config.fog.ground },
        uAnisotropy: { value: config.fog.anisotropy }, uShafts: { value: config.fog.shafts }, uSteps: { value: 20 }
      }
    });
    this.composite = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERTEX, fragmentShader: COMPOSITE_FRAGMENT, depthTest: false, depthWrite: false,
      uniforms: { tFrame: { value: null }, tVolume: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uAmount: { value: 0 }, uNear: { value: 0.1 }, uFar: { value: 20000 } }
    });
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  get opacity() { return this.amount; }

  setOpacity(amount: number) {
    this.amount = amount;
    this.root.visible = this.sun.visible = this.fill.visible = amount > 0.001;
    this.sun.intensity = this.config.sun.intensity * amount;
    this.fill.intensity = 0.3 * amount;
    if (this.ground) {
      this.ground.material.opacity = amount;
      const transparent = amount < 1;
      if (this.ground.material.transparent !== transparent) { this.ground.material.transparent = transparent; this.ground.material.needsUpdate = true; }
      this.ground.material.depthWrite = amount > 0.9;
    }
  }

  setSky(amount: number) {
    this.sky.visible = amount > 0.001;
    this.sky.material.uniforms.opacity.value = amount;
  }

  invalidateShadow() { this.sun.shadow.needsUpdate = true; }

  update(camera: THREE.Camera) {
    if (!this.amount) return;
    this.sky.position.copy(camera.position);
    this.sky.material.uniforms.time.value = performance.now() / 1000;
    // A sun-aligned stable shadow region expands for aerial views, contracts at
    // eye level. Snap in light space to avoid crawling edges when the camera moves.
    this.eye.copy(camera.position).applyMatrix4(this.worldToSite);
    camera.getWorldDirection(this.forward);
    const ground = this.config.fog.ground;
    this.localForward.copy(this.forward).transformDirection(this.worldToSite);
    const localDown = this.localForward.y;
    const distance = localDown < -0.12 ? Math.max(100, Math.min(2500, (this.eye.y - ground) * this.site.scale.x / -localDown)) : 180;
    const extent = Math.max(180, Math.min(1800, distance * 0.85));
    this.focus.copy(camera.position).addScaledVector(this.forward, Math.min(1600, distance));
    this.focus.applyMatrix4(this.worldToSite);
    this.focus.y = ground;
    this.focus.applyMatrix4(this.site.matrixWorld);
    const texel = 2 * extent / this.sun.shadow.mapSize.x;
    // Project onto the light's axes before snapping, rather than world axes.
    const az = Math.atan2(this.sunDirection.x, this.sunDirection.z);
    const c = Math.cos(az), s = Math.sin(az);
    const x = Math.round((this.focus.x * c - this.focus.z * s) / texel) * texel;
    const z = Math.round((this.focus.x * s + this.focus.z * c) / texel) * texel;
    this.focus.x = x * c + z * s;
    this.focus.z = -x * s + z * c;
    if (this.previousFocus.distanceToSquared(this.focus) > texel * texel || Math.abs(extent - this.previousExtent) > 2) {
      this.sun.target.position.copy(this.focus);
      this.sun.position.copy(this.focus).addScaledVector(this.sunDirection, 5000);
      const shadow = this.sun.shadow.camera;
      shadow.left = shadow.bottom = -extent;
      shadow.right = shadow.top = extent;
      shadow.updateProjectionMatrix();
      this.previousFocus.copy(this.focus);
      this.previousExtent = extent;
      this.invalidateShadow();
    }
  }

  private prepare(renderer: THREE.WebGLRenderer, materials: THREE.Material[]) {
    if (this.prepared) return;
    this.prepared = true;
    this.compact = renderer.domElement.clientWidth < 740;
    this.floatTargets = Boolean(renderer.getContext().getExtension("EXT_color_buffer_float"));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.sun.shadow.mapSize.setScalar(Math.min(renderer.capabilities.maxTextureSize, this.compact ? 1024 : 2048));
    this.scattering.uniforms.uSteps.value = this.compact ? 12 : 20;
    this.invalidateShadow();
    // A small prefiltered analytic sky gives the stone diffuse sky light and
    // coherent reflections; the solar disc is excluded to avoid bright speckles.
    const dome = new Sky();
    for (const key of Object.keys(dome.material.uniforms)) {
      const value = this.sky.material.uniforms[key]?.value;
      if (value instanceof THREE.Vector3) dome.material.uniforms[key].value.copy(value);
      else if (value !== undefined) dome.material.uniforms[key].value = value;
    }
    dome.material.uniforms.showSunDisc.value = 0;
    dome.scale.setScalar(10000);
    const environmentScene = new THREE.Scene();
    environmentScene.add(dome);
    const pmrem = new THREE.PMREMGenerator(renderer);
    try { this.environmentMap = pmrem.fromScene(environmentScene, 0.04, 0.1, 20000, { size: 128 }); }
    finally { pmrem.dispose(); dome.geometry.dispose(); dome.material.dispose(); }
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      material.envMap = this.environmentMap.texture;
      material.envMapIntensity = 0.12;
      material.needsUpdate = true;
    }
    if (this.ground) { this.ground.material.envMap = this.environmentMap.texture; this.ground.material.envMapIntensity = 0.12; }
  }

  /** Draw into the caller's current target, so tour looks still work above this. */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, materials: THREE.Material[]) {
    if (this.amount <= 0.001) return false;
    this.prepare(renderer, materials);
    this.ensureTargets(renderer);
    const output = renderer.getRenderTarget();
    const fog = this.scene.fog;
    this.scene.fog = null;
    try {
      renderer.setRenderTarget(this.frame);
      renderer.render(this.scene, camera);
      const uniforms = this.scattering.uniforms;
      uniforms.tDepth.value = this.frame!.depthTexture;
      uniforms.tShadow.value = this.sun.shadow.map!.depthTexture;
      uniforms.uProjection.value.copy(camera.projectionMatrix);
      uniforms.uProjectionInverse.value.copy(camera.projectionMatrixInverse);
      uniforms.uCameraMatrix.value.copy(camera.matrixWorld);
      uniforms.uEye.value.copy(camera.position);
      this.quad.material = this.scattering;
      renderer.setRenderTarget(this.volume);
      renderer.render(this.quadScene, this.quadCamera);
      const compose = this.composite.uniforms;
      compose.tFrame.value = this.frame!.texture;
      compose.tVolume.value = this.volume!.texture;
      compose.tDepth.value = this.frame!.depthTexture;
      compose.uAmount.value = this.amount;
      compose.uNear.value = camera.near;
      compose.uFar.value = camera.far;
      compose.uTexel.value.set(1 / this.volume!.width, 1 / this.volume!.height);
      this.quad.material = this.composite;
      renderer.setRenderTarget(output);
      renderer.render(this.quadScene, this.quadCamera);
    } finally {
      this.scene.fog = fog;
      renderer.setRenderTarget(output);
    }
    return true;
  }

  private ensureTargets(renderer: THREE.WebGLRenderer) {
    const output = renderer.getRenderTarget();
    if (output) this.size.set(output.width, output.height); else renderer.getDrawingBufferSize(this.size);
    const width = Math.max(1, Math.round(this.size.x)), height = Math.max(1, Math.round(this.size.y));
    const compact = renderer.domElement.clientWidth < 740;
    if (compact !== this.compact) {
      this.compact = compact;
      this.sun.shadow.map?.depthTexture?.dispose();
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.sun.shadow.mapSize.setScalar(Math.min(renderer.capabilities.maxTextureSize, compact ? 1024 : 2048));
      this.scattering.uniforms.uSteps.value = compact ? 12 : 20;
      this.previousFocus.set(Infinity, Infinity, Infinity);
      this.invalidateShadow();
    }
    if (this.frame?.width === width && this.frame.height === height) return;
    this.frame?.depthTexture?.dispose();
    this.frame?.dispose();
    this.volume?.dispose();
    const type = this.floatTargets ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.frame = new THREE.WebGLRenderTarget(width, height, { type, depthBuffer: true });
    this.frame.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
    // Pixel cost is capped independently of DPR and monitor size.
    const scale = Math.min(0.5, (this.compact ? 320 : 640) / width, 360 / height);
    this.volume = new THREE.WebGLRenderTarget(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), { type, depthBuffer: false });
  }

  getDebugSnapshot() {
    return { enabled: this.amount > 0, sky: this.sky.visible ? this.sky.material.uniforms.opacity.value : 0, sun: this.config.sun, fog: this.config.fog, shadows: this.sun.shadow.mapSize.x, volume: this.volume ? [this.volume.width, this.volume.height, this.scattering.uniforms.uSteps.value] : null };
  }

  dispose() {
    this.scene.remove(this.root, this.sky, this.sun, this.sun.target, this.fill);
    this.ground?.geometry.dispose();
    this.ground?.material.dispose();
    this.sky.geometry.dispose(); this.sky.material.dispose();
    this.sun.shadow.dispose();
    this.environmentMap?.dispose();
    this.frame?.depthTexture?.dispose(); this.frame?.dispose(); this.volume?.dispose();
    this.scattering.dispose(); this.composite.dispose(); this.quad.geometry.dispose();
  }
}

function createGround(config: NonNullable<ReconstructionEnvironmentConfig["ground"]>) {
  const geometry = new THREE.PlaneGeometry(config.radius * 2, config.radius * 2, 96, 96).rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), z = positions.getZ(i);
    const away = THREE.MathUtils.smoothstep(Math.hypot(x, z), 1800, 6000);
    positions.setY(i, config.height + away * config.relief * (0.5 + 0.28 * Math.sin(x * 0.0015 + Math.sin(z * 0.0008)) + 0.22 * Math.sin(z * 0.002)));
  }
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: config.color, roughness: 1 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = "varying vec3 vBackdrop;\n" + shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvBackdrop = position;");
    shader.fragmentShader = "varying vec3 vBackdrop;\n" + shader.fragmentShader.replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= 0.96 + 0.04 * sin(vBackdrop.x * 0.006 + sin(vBackdrop.z * 0.004));");
  };
  material.customProgramCacheKey = () => "reconstruction-distant-ground-v1";
  const ground = new THREE.Mesh(geometry, material);
  ground.name = "reconstruction-distant-ground";
  ground.receiveShadow = true;
  return ground;
}

const VOLUME_FRAGMENT = `
  varying vec2 vUv;
  uniform sampler2D tDepth;
  uniform highp sampler2DShadow tShadow;
  uniform mat4 uProjection, uProjectionInverse, uCameraMatrix, uShadowMatrix, uWorldToSite;
  uniform vec3 uEye, uSun, uFogColor, uSunColor;
  uniform float uDensity, uHeight, uGround, uAnisotropy, uShafts;
  uniform int uSteps;
  float hash(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  void main() {
    float depth = texture2D(tDepth, vUv).r;
    vec4 view = uProjectionInverse * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    view /= view.w;
    vec3 end = (uCameraMatrix * vec4(view.xyz, 1.0)).xyz;
    vec3 ray = end - uEye;
    float distance = min(length(ray), depth > 0.999999 ? 6500.0 : 15000.0);
    vec3 direction = normalize(ray);
    float stepSize = distance / float(uSteps);
    float localStep = stepSize * length((uWorldToSite * vec4(direction, 0.0)).xyz);
    float jitter = hash(gl_FragCoord.xy);
    float phase = (1.0 - uAnisotropy * uAnisotropy) / pow(max(0.05, 1.0 + uAnisotropy * uAnisotropy - 2.0 * uAnisotropy * dot(direction, uSun)), 1.5);
    vec3 scattered = vec3(0.0);
    float transmittance = 1.0;
    for (int i = 0; i < 20; i++) {
      if (i >= uSteps) break;
      vec3 point = uEye + direction * ((float(i) + jitter) * stepSize);
      vec3 local = (uWorldToSite * vec4(point, 1.0)).xyz;
      float height = max(0.0, local.y - uGround);
      // A thin high layer plus denser dust near the ground; no opaque fog wall.
      float density = uDensity * (0.12 + 0.88 * exp(-height / uHeight));
      float wisps = 0.94 + 0.06 * sin(local.x * 0.008 + sin(local.z * 0.006) + local.y * 0.02);
      float extinction = exp(-density * wisps * localStep);
      vec4 shadow = uShadowMatrix * vec4(point, 1.0);
      vec3 coord = shadow.xyz / shadow.w;
      float lit = 1.0;
      if (all(greaterThanEqual(coord, vec3(0.0))) && all(lessThanEqual(coord, vec3(1.0)))) {
        float edge = min(min(coord.x, 1.0 - coord.x), min(coord.y, 1.0 - coord.y));
        lit = mix(1.0, texture(tShadow, vec3(coord.xy, coord.z - 0.00008)), smoothstep(0.0, 0.05, edge));
      }
      vec3 light = uFogColor * 0.65 + uSunColor * (0.22 + phase * 0.12 * uShafts) * lit;
      scattered += transmittance * (1.0 - extinction) * light;
      transmittance *= extinction;
    }
    // Hemisphere occlusion from the same depth buffer adds contact shading at
    // feet and wall bases. Radius follows perspective, with a strict meter cap.
    float occlusion = 0.0;
    vec3 normal = normalize(cross(dFdx(view.xyz), dFdy(view.xyz)));
    if (dot(normal, view.xyz) > 0.0) normal = -normal;
    if (depth < 0.999999) {
      vec3 tangent = normalize(cross(normal, abs(normal.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0)));
      vec3 bitangent = cross(normal, tangent);
      float radius = clamp(-view.z * 0.014, 0.3, 20.0);
      for (int j = 0; j < 8; j++) {
        float angle = jitter * 6.2831853 + float(j) * 2.399963;
        vec3 samplePoint = view.xyz + normal * radius * 0.3 + (tangent * cos(angle) + bitangent * sin(angle)) * radius * (0.25 + 0.75 * float(j) / 8.0);
        vec4 projected = uProjection * vec4(samplePoint, 1.0);
        vec2 uv = projected.xy / projected.w * 0.5 + 0.5;
        if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) {
          float sampleDepth = texture2D(tDepth, uv).r;
          vec4 sampleView = uProjectionInverse * vec4(uv * 2.0 - 1.0, sampleDepth * 2.0 - 1.0, 1.0);
          float sampleZ = sampleView.z / sampleView.w;
          occlusion += step(samplePoint.z + radius * 0.04, sampleZ) * smoothstep(0.0, 1.0, radius / max(0.001, abs(view.z - sampleZ)));
        }
      }
    }
    gl_FragColor = vec4(scattered, transmittance * (1.0 - 0.4 * occlusion / 8.0));
  }
`;

const COMPOSITE_FRAGMENT = `
  varying vec2 vUv;
  uniform sampler2D tFrame, tVolume, tDepth;
  uniform vec2 uTexel;
  uniform float uAmount, uNear, uFar;
  float distanceAt(vec2 uv) {
    float d = texture2D(tDepth, uv).r;
    return (uNear * uFar) / max(0.0001, uFar - d * (uFar - uNear));
  }
  void main() {
    vec4 frame = texture2D(tFrame, vUv);
    float center = distanceAt(vUv);
    vec4 volume = vec4(0.0);
    float weights = 0.0;
    // Depth-aware upsampling keeps the sky's shafts off nearby faces and paws.
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
      vec2 uv = vUv + (vec2(float(x), float(y)) - 0.5) * uTexel;
      float weight = 1.0 / (1.0 + abs(distanceAt(uv) - center) / max(1.0, center * 0.02));
      volume += texture2D(tVolume, uv) * weight;
      weights += weight;
    }
    volume /= weights;
    gl_FragColor = vec4(frame.rgb * mix(1.0, volume.a, uAmount) + volume.rgb * uAmount, frame.a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
