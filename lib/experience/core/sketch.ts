import * as THREE from "three";
import type { EffectFactory, EffectHandle, SplatModifier } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";

/**
 * The space as a pencil drawing that a radial scan turns back into color, as in
 * the original garden demo: a first front draws the sketch onto blank paper and
 * a second front paints the photograph in behind it.
 *
 * Splats are restyled on the GPU. Long thin splats and fine details, which carry
 * a capture's edges, become ink strokes; dark areas become shading; broad flat
 * splats fade into the paper. When the space has a companion splat trained on
 * line drawings (a SplatConfig with role "sketch"), that drawing is used instead.
 * Panorama spaces draw a hatched sketch over the capture mesh.
 */

const overlayVertex = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormalWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormalWorld = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const overlayFragment = /* glsl */ `
  uniform vec3 uOrigin;
  uniform vec3 uInk;
  uniform vec3 uPaper;
  uniform float uSketchRadius;
  uniform float uColorRadius;
  uniform float uWidth;
  uniform float uStrength;
  uniform float uInvert;
  varying vec3 vWorld;
  varying vec3 vNormalWorld;
  float cellHash(vec3 p) { return fract(sin(dot(floor(p * 4.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  void main() {
    float d = distance(vWorld, uOrigin);
    float jitter = (cellHash(vWorld) - 0.5) * uWidth * 1.5;
    float colored = 1.0 - smoothstep(uColorRadius - uWidth, uColorRadius, d + jitter);
    colored = mix(colored, 1.0 - colored, uInvert);
    float drawn = 1.0 - smoothstep(uSketchRadius - uWidth, uSketchRadius, d + jitter);
    vec3 n = normalize(vNormalWorld);
    float light = 0.5 + 0.5 * max(dot(n, normalize(vec3(0.35, 0.85, 0.4))), 0.0);
    float crease = smoothstep(0.08, 0.35, length(fwidth(n)));
    float shade = 1.0 - light;
    float diagonal = fract((gl_FragCoord.x - gl_FragCoord.y) / 6.0);
    float cross = fract((gl_FragCoord.x + gl_FragCoord.y) / 8.0);
    float hatch = step(0.62, diagonal) * smoothstep(0.12, 0.3, shade) + step(0.7, cross) * smoothstep(0.3, 0.45, shade);
    float ink = clamp(max(crease, hatch * 0.7), 0.0, 1.0);
    vec3 color = mix(uPaper, uInk, ink);
    float front = (1.0 - smoothstep(0.0, uWidth * 0.5, abs(d + jitter - uColorRadius))) * (1.0 - uInvert);
    float alpha = (1.0 - colored) * drawn * uStrength;
    color = mix(color, vec3(1.0, 0.96, 0.85), front * 0.6);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

const PROCEDURAL = `
  float skD = distance(gs.center, uOrigin);
  float skJ = (fract(sin(dot(floor(gs.center * 4.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453) - 0.5) * uWidth * 1.5;
  float skColor = 1.0 - smoothstep(uColorRadius - uWidth, uColorRadius, skD + skJ);
  skColor = mix(skColor, 1.0 - skColor, uInvert);
  float skShow = 1.0 - smoothstep(uSketchRadius - uWidth, uSketchRadius, skD + skJ);
  vec3 skS = gs.scales;
  float skMax = max(skS.x, max(skS.y, skS.z));
  float skMin = min(skS.x, min(skS.y, skS.z));
  float skMid = max(skS.x + skS.y + skS.z - skMax - skMin, 1e-5);
  float skLum = dot(gs.rgba.rgb, vec3(0.299, 0.587, 0.114));
  float skLine = smoothstep(2.2, 7.0, skMax / skMid) * (1.0 - smoothstep(0.03, 0.25, skMid));
  float skFine = 1.0 - smoothstep(0.004, 0.03, skMax);
  float skShade = smoothstep(0.62, 0.12, skLum);
  float skInk = clamp(max(max(skLine, skFine * 0.7), skShade * 0.75), 0.0, 1.0);
  vec3 skRgb = mix(uPaper, uInk, skInk);
  float skAlpha = gs.rgba.a * mix(0.05, 0.95, skInk) * skShow;
  vec3 skScales = gs.scales * mix(1.0, 0.55, skInk);
  float skFront = (1.0 - smoothstep(0.0, uWidth * 0.5, abs(skD + skJ - uColorRadius))) * (1.0 - uInvert);
  vec3 skPainted = gs.rgba.rgb + vec3(0.35, 0.3, 0.2) * skFront;
  vec3 skOutRgb = mix(skRgb, skPainted, skColor);
  float skOutA = mix(skAlpha, gs.rgba.a, skColor);
  vec3 skOutScales = mix(skScales, gs.scales, skColor);
  gs.rgba.rgb = mix(gs.rgba.rgb, skOutRgb, uStrength);
  gs.rgba.a = mix(gs.rgba.a, skOutA, uStrength);
  gs.scales = mix(gs.scales, skOutScales, uStrength);
`;

/** With a companion line-drawing splat: color shows inside the front, the drawing outside it. */
const COMPANION_COLOR = `
  float skD = distance(gs.center, uOrigin);
  float skJ = (fract(sin(dot(floor(gs.center * 4.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453) - 0.5) * uWidth * 1.5;
  float skColor = 1.0 - smoothstep(uColorRadius - uWidth, uColorRadius, skD + skJ);
  skColor = mix(skColor, 1.0 - skColor, uInvert);
  gs.rgba.a *= mix(1.0, skColor, uStrength);
`;
const COMPANION_SKETCH = `
  float skD = distance(gs.center, uOrigin);
  float skJ = (fract(sin(dot(floor(gs.center * 4.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453) - 0.5) * uWidth * 1.5;
  float skColor = 1.0 - smoothstep(uColorRadius - uWidth, uColorRadius, skD + skJ);
  skColor = mix(skColor, 1.0 - skColor, uInvert);
  float skShow = 1.0 - smoothstep(uSketchRadius - uWidth, uSketchRadius, skD + skJ);
  gs.rgba.a *= (1.0 - skColor) * skShow * uStrength;
`;

const UNIFORMS = { uOrigin: "vec3", uSketchRadius: "float", uColorRadius: "float", uWidth: "float", uInk: "vec3", uPaper: "vec3", uStrength: "float", uInvert: "float" } as const;

const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const origin = new THREE.Vector3();
  const ink = new THREE.Color();
  const paper = new THREE.Color();
  const bounds = new THREE.Box3();
  const corner = new THREE.Vector3();
  let active = false;
  let strength = 0;
  let sketchRadius = 0;
  let colorRadius = 0;
  let maxRadius = 30;
  let clock = 0;

  // Splats: live uniforms shared by every modifier this effect adds.
  const splats = context.splats;
  const removals: (() => void)[] = [];
  const values = splats ? Object.fromEntries(Object.entries(UNIFORMS).map(([name, type]) => [name, type === "float" ? splats.dyno.dynoFloat(0) : splats.dyno.dynoVec3(new THREE.Vector3())])) : null;
  const modifier = (body: string): SplatModifier => (dyno, gsplat) => {
    const node = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, ...UNIFORMS },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs, outputs }) => dyno.unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        {
          ${Object.entries(UNIFORMS).map(([name, type]) => `${type} ${name} = ${(inputs as Record<string, string>)[name]};`).join("\n")}
          ${body.replaceAll("gs.", `${outputs.gsplat}.`)}
        }
      `)
    });
    return node.apply({ gsplat, ...values } as never).gsplat;
  };
  if (splats) {
    if (splats.hasSketch) {
      removals.push(splats.addModifier(modifier(COMPANION_COLOR), "color"));
      removals.push(splats.addModifier(modifier(COMPANION_SKETCH), "sketch"));
    } else removals.push(splats.addModifier(modifier(PROCEDURAL), "color"));
  }

  // Capture meshes: a hatched drawing laid over the photograph.
  const overlays = new THREE.Group();
  const material = new THREE.ShaderMaterial({
    vertexShader: overlayVertex,
    fragmentShader: overlayFragment,
    uniforms: {
      uOrigin: { value: origin }, uInk: { value: ink }, uPaper: { value: paper }, uSketchRadius: { value: 0 }, uColorRadius: { value: 0 },
      uWidth: { value: 0.6 }, uStrength: { value: 0 }, uInvert: { value: 0 }
    },
    transparent: true,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.DoubleSide
  });
  for (const source of context.surfaces()) {
    const overlay = new THREE.Mesh(source.geometry, material);
    overlay.matrixAutoUpdate = false;
    overlay.renderOrder = 39;
    overlay.frustumCulled = false;
    overlay.userData.source = source;
    overlays.add(overlay);
  }
  context.scene.add(overlays);

  // In splat spaces the background becomes paper while the drawing shows.
  const background = context.scene.background;
  const dark = new THREE.Color(0x0a0c10);
  const backdrop = new THREE.Color();
  const usesPaper = Boolean(splats) && !context.surfaces().length;

  // Panoramas: the photograph itself is drawn and revealed in a widening circle around the target.
  const panorama = context.panorama;
  const direction = new THREE.Vector3(0, 0, -1);
  let sketchAngle = 0;
  let colorAngle = 0;

  const mode = () => str(params, "mode", "reveal");
  const measure = () => {
    const object = context.object();
    if (instance.target.kind === "scene" && !object) origin.copy(context.camera.position);
    else context.anchor(origin);
    context.spaceBounds(bounds);
    maxRadius = 4;
    if (!bounds.isEmpty()) {
      for (let index = 0; index < 8; index += 1) {
        corner.set(index & 1 ? bounds.max.x : bounds.min.x, index & 2 ? bounds.max.y : bounds.min.y, index & 4 ? bounds.max.z : bounds.min.z);
        maxRadius = Math.max(maxRadius, corner.distanceTo(origin));
      }
    }
    maxRadius = Math.min(maxRadius, 400);
  };

  const start = () => {
    measure();
    clock = 0;
    const current = mode();
    sketchRadius = current === "reveal" ? 0 : maxRadius + 10;
    colorRadius = 0;
    sketchAngle = current === "reveal" ? 0 : Math.PI + 1;
    colorAngle = 0;
    if (instance.target.kind === "scene" && !context.object()) context.camera.getWorldDirection(direction);
    else direction.copy(origin).sub(context.camera.position).normalize();
  };

  const sync = () => {
    ink.set(str(params, "ink", "#2b2a27"));
    paper.set(str(params, "paper", "#f2efe6"));
    const width = num(params, "width", 0.8);
    const invert = mode() === "toSketch" ? 1 : 0;
    if (panorama) {
      const firstPerson = context.viewMode() === "FPV";
      panorama.uSketch.value = firstPerson ? strength : 0;
      panorama.uInk.value.copy(ink);
      panorama.uPaper.value.copy(paper);
      panorama.uRevealDirection.value.copy(direction);
      panorama.uSketchAngle.value = sketchAngle;
      panorama.uColorAngle.value = colorAngle;
      panorama.uAngleWidth.value = Math.min(0.6, width / 4);
      panorama.uInvert.value = invert;
    }
    material.uniforms.uSketchRadius.value = sketchRadius;
    material.uniforms.uColorRadius.value = colorRadius;
    material.uniforms.uWidth.value = width;
    material.uniforms.uStrength.value = strength;
    material.uniforms.uInvert.value = invert;
    if (values && splats) {
      (values.uOrigin.value as THREE.Vector3).copy(origin);
      values.uSketchRadius.value = sketchRadius;
      values.uColorRadius.value = colorRadius;
      values.uWidth.value = width;
      (values.uInk.value as THREE.Vector3).set(ink.r, ink.g, ink.b);
      (values.uPaper.value as THREE.Vector3).set(paper.r, paper.g, paper.b);
      values.uStrength.value = strength;
      values.uInvert.value = invert;
      splats.invalidate();
    }
  };

  // The paper behind a drawing in a splat space gives way once the color front passes the visitor.
  let paperAmount = 0;
  const updatePaper = (delta: number) => {
    if (!usesPaper) return;
    const passed = colorRadius > context.camera.position.distanceTo(origin) + num(params, "width", 0.8);
    const current = mode();
    const target = !active ? 0 : current === "sketch" ? 1 : current === "toSketch" ? (passed ? 1 : 0) : passed ? 0 : 1;
    const before = paperAmount;
    paperAmount += (target - paperAmount) * Math.min(1, delta * 2.5);
    if (Math.abs(target - paperAmount) < 0.002) paperAmount = target;
    const amount = paperAmount * strength;
    if (amount === 0 && before === 0) return;
    context.scene.background = amount > 0.002 ? backdrop.copy(dark).lerp(paper, amount) : background;
  };

  const handle: EffectHandle = {
    update({ delta }) {
      for (const overlay of overlays.children) {
        const source = overlay.userData.source as THREE.Mesh;
        overlay.matrix.copy(source.matrixWorld);
        overlay.matrixWorld.copy(source.matrixWorld);
      }
      const before = [strength, sketchRadius, colorRadius, sketchAngle, colorAngle].join();
      const target = active ? 1 : 0;
      strength += (target - strength) * Math.min(1, delta * 3);
      if (Math.abs(target - strength) < 0.002) strength = target;
      if (active) {
        clock += delta;
        const speed = num(params, "speed", 4) * (context.reducedMotion ? 3 : 1);
        const current = mode();
        if (sketchRadius < maxRadius + 10) sketchRadius += delta * speed * 1.4;
        // Around a panorama the fronts open as angles, about one radian per four meters.
        if (sketchAngle < Math.PI + 1) sketchAngle += delta * speed * 1.4 / 4;
        const hold = num(params, "hold", 2);
        const sketchDone = current === "reveal" ? clock > Math.min(maxRadius / (speed * 1.4), (Math.PI + 1) * 4 / (speed * 1.4)) + hold : clock > hold;
        if (current !== "sketch" && sketchDone) {
          if (colorRadius < maxRadius + 10) colorRadius += delta * speed;
          if (colorAngle < Math.PI + 1) colorAngle += delta * speed / 4;
        }
      }
      // The mesh drawing serves the overview; in first person the photograph itself is drawn.
      overlays.visible = strength > 0.002 && (!panorama || context.viewMode() === "ORBIT");
      splats?.showSketch(strength > 0.002 && splats.hasSketch);
      if ([strength, sketchRadius, colorRadius, sketchAngle, colorAngle].join() !== before || (panorama && strength > 0)) sync();
      updatePaper(delta);
    },
    setActive(value) {
      if (value && !active) start();
      active = value;
      sync();
    },
    play() { start(); active = true; },
    setParams(next) { params = next; sync(); },
    dispose() {
      removals.forEach((remove) => remove());
      if (panorama) panorama.uSketch.value = 0;
      splats?.showSketch(false);
      if (usesPaper) context.scene.background = background;
      context.scene.remove(overlays);
      material.dispose();
    }
  };
  return handle;
};

export default create;
