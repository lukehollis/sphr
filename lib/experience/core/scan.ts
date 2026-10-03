import * as THREE from "three";
import type { EffectFactory, EffectHandle, SplatModifier } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";

/**
 * A ring of light that sweeps outward from the target across the capture.
 * In a splat space every splat is rewritten on the GPU: splats beyond the
 * front stay hidden while revealing, the front glows, and the scanned area
 * keeps a faint tint. In a panorama space the band is drawn over the space's
 * mesh so it sweeps across the photograph like a laser scan.
 */

const surfaceVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const surfaceFragment = /* glsl */ `
  uniform vec3 uOrigin;
  uniform vec3 uColor;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uStrength;
  uniform float uReveal;
  varying vec3 vWorld;
  void main() {
    float d = distance(vWorld, uOrigin);
    float front = 1.0 - smoothstep(0.0, uWidth, abs(d - uRadius));
    float wake = smoothstep(uRadius - uWidth * 6.0, uRadius, d) * step(d, uRadius) * 0.45;
    float lines = 0.55 + 0.45 * smoothstep(0.6, 1.0, abs(sin(vWorld.y * 18.0)));
    float glow = (front * lines * 1.6 + wake) * uStrength;
    // Revealing: the photograph stays dark until the front passes over it.
    float ahead = smoothstep(uRadius - uWidth * 0.25, uRadius + uWidth * 0.25, d) * uReveal * uStrength;
    if (glow < 0.004 && ahead < 0.004) discard;
    gl_FragColor = vec4(uColor * glow, ahead * 0.9);
  }
`;

const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const origin = new THREE.Vector3();
  const color = new THREE.Color();
  const bounds = new THREE.Box3();
  const corner = new THREE.Vector3();
  let active = false;
  let running = false;
  let radius = 0;
  let maxRadius = 30;
  let strength = 0;
  let sinceStart = 0;

  // Surfaces: overlay meshes that share the capture mesh's geometry.
  const overlays = new THREE.Group();
  overlays.name = `effect-scan-${instance.id}`;
  const material = new THREE.ShaderMaterial({
    vertexShader: surfaceVertex,
    fragmentShader: surfaceFragment,
    uniforms: {
      uOrigin: { value: origin },
      uColor: { value: color },
      uRadius: { value: 0 },
      uWidth: { value: 0.6 },
      uStrength: { value: 0 },
      uReveal: { value: 1 }
    },
    transparent: true,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    // Premultiplied: color adds the glowing band, alpha darkens what is not yet scanned.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.DoubleSide
  });
  const surfaces = context.surfaces();
  for (const source of surfaces) {
    const overlay = new THREE.Mesh(source.geometry, material);
    overlay.matrixAutoUpdate = false;
    overlay.renderOrder = 40;
    overlay.frustumCulled = false;
    overlay.userData.source = source;
    overlays.add(overlay);
  }
  context.scene.add(overlays);

  // Splats: one modifier with live uniforms.
  let removeModifier: (() => void) | null = null;
  const splats = context.splats;
  const uniforms = splats ? {
    origin: splats.dyno.dynoVec3(new THREE.Vector3()),
    radius: splats.dyno.dynoFloat(0),
    width: splats.dyno.dynoFloat(0.6),
    color: splats.dyno.dynoVec3(new THREE.Vector3(0.5, 0.84, 1)),
    reveal: splats.dyno.dynoFloat(1),
    strength: splats.dyno.dynoFloat(0)
  } : null;
  if (splats && uniforms) {
    const modifier: SplatModifier = (dyno, gsplat) => {
      const node = new dyno.Dyno({
        inTypes: { gsplat: dyno.Gsplat, origin: "vec3", radius: "float", width: "float", color: "vec3", reveal: "float", strength: "float" },
        outTypes: { gsplat: dyno.Gsplat },
        statements: ({ inputs, outputs }) => dyno.unindentLines(`
          ${outputs.gsplat} = ${inputs.gsplat};
          float scanDistance = distance(${inputs.gsplat}.center, ${inputs.origin});
          float scanFront = 1.0 - smoothstep(0.0, ${inputs.width}, abs(scanDistance - ${inputs.radius}));
          float scanAhead = smoothstep(${inputs.radius} - ${inputs.width} * 0.25, ${inputs.radius} + ${inputs.width} * 0.25, scanDistance);
          float scanHide = scanAhead * ${inputs.reveal} * ${inputs.strength};
          ${outputs.gsplat}.rgba.a *= 1.0 - scanHide;
          ${outputs.gsplat}.rgba.rgb = mix(${outputs.gsplat}.rgba.rgb, ${inputs.color} * 1.6, scanFront * ${inputs.strength} * 0.85);
          ${outputs.gsplat}.scales *= 1.0 + scanFront * ${inputs.strength} * 0.35;
        `)
      });
      return node.apply({
        gsplat, origin: uniforms.origin, radius: uniforms.radius, width: uniforms.width,
        color: uniforms.color, reveal: uniforms.reveal, strength: uniforms.strength
      }).gsplat;
    };
    removeModifier = splats.addModifier(modifier);
  }

  const start = () => {
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
    radius = 0;
    sinceStart = 0;
    running = true;
  };

  const sync = () => {
    color.set(str(params, "color", "#7fd6ff"));
    const width = num(params, "width", 0.6);
    material.uniforms.uWidth.value = width;
    material.uniforms.uRadius.value = radius;
    material.uniforms.uStrength.value = strength;
    material.uniforms.uReveal.value = str(params, "mode", "reveal") === "reveal" ? 1 : 0;
    if (uniforms && splats) {
      uniforms.origin.value.copy(origin);
      uniforms.radius.value = radius;
      uniforms.width.value = width;
      uniforms.color.value.set(color.r, color.g, color.b);
      uniforms.reveal.value = str(params, "mode", "reveal") === "reveal" ? 1 : 0;
      uniforms.strength.value = strength;
      splats.invalidate();
    }
  };

  const handle: EffectHandle = {
    update({ delta }) {
      for (const overlay of overlays.children) {
        const source = overlay.userData.source as THREE.Mesh;
        overlay.matrix.copy(source.matrixWorld);
        overlay.matrixWorld.copy(source.matrixWorld);
      }
      const pulse = str(params, "mode", "reveal") === "pulse";
      const target = active ? 1 : 0;
      const before = strength;
      strength += (target - strength) * Math.min(1, delta * 3);
      if (Math.abs(target - strength) < 0.002) strength = target;
      let changed = running || strength !== before;
      if (active) {
        sinceStart += delta;
        if (running) {
          radius += delta * num(params, "speed", 6) * (context.reducedMotion ? 3 : 1);
          if (radius > maxRadius + num(params, "width", 0.6)) {
            running = false;
            radius = maxRadius * 4 + 100;
            changed = true;
          }
        } else if (pulse && sinceStart > num(params, "every", 6)) start();
      }
      overlays.visible = strength > 0.002 && (running || pulse);
      if (changed) sync();
    },
    setActive(value) {
      if (value && !active) start();
      active = value;
      if (!value) running = false;
      sync();
    },
    play() { start(); active = true; },
    setParams(next) { params = next; sync(); },
    dispose() {
      removeModifier?.();
      context.scene.remove(overlays);
      material.dispose();
    }
  };
  return handle;
};

export default create;
