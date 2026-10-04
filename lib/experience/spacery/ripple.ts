import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach, floorBelow } from "./common";

/** Rings spreading across the ground from the target, like water or a sound wave. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const color = new THREE.Color();
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: color }, uOpacity: { value: 0 }, uSpeed: { value: 1 }, uRings: { value: 4 } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime, uOpacity, uSpeed, uRings;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float wave = 0.0;
        for (int i = 0; i < 6; i++) {
          if (float(i) >= uRings) break;
          float phase = fract(uTime * uSpeed * 0.35 + float(i) / uRings);
          float ring = exp(-pow((r - phase) * 28.0, 2.0));
          wave += ring * (1.0 - phase) * (1.0 - phase);
        }
        float alpha = wave * uOpacity * (1.0 - smoothstep(0.85, 1.0, r));
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(uColor, alpha);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), material);
  mesh.renderOrder = 46;
  context.scene.add(mesh);
  const anchor = new THREE.Vector3();
  // Where rings for a cue spread from while the ripple is not running, kept as a found object flies off.
  const spot = new THREE.Vector3();
  const box = new THREE.Box3();
  let active = false;
  let pinned = false;
  let pulse = 0;
  let floorY: number | null = null;
  const ground = (out: THREE.Vector3) => {
    context.anchor(out);
    if (context.object()) { context.bounds(box); out.y = box.min.y; return out; }
    if (floorY === null) floorY = floorBelow(out, context.surfaces(), out.y);
    out.y = floorY;
    return out;
  };
  return {
    update({ time, delta }) {
      pulse = Math.max(0, pulse - delta);
      material.uniforms.uOpacity.value = approach(material.uniforms.uOpacity.value, active || pulse > 0 ? 1 : 0, delta, 2);
      mesh.visible = material.uniforms.uOpacity.value > 0.01;
      if (!mesh.visible) return;
      material.uniforms.uTime.value = time;
      color.set(str(params, "color", "#bfe9ff"));
      material.uniforms.uSpeed.value = num(params, "speed", 1);
      material.uniforms.uRings.value = num(params, "rings", 4);
      if (pinned) anchor.copy(spot);
      else ground(anchor);
      mesh.position.copy(anchor).y += 0.02;
      mesh.scale.setScalar(num(params, "radius", 2));
    },
    setActive(value) { active = value; if (value) pinned = false; },
    play() {
      pulse = 4;
      if (!active) { ground(spot); pinned = true; }
    },
    setParams(next) { params = next; floorY = null; },
    dispose() { context.scene.remove(mesh); mesh.geometry.dispose(); material.dispose(); }
  };
};

export default create;
