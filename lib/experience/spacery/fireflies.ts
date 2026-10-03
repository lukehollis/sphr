import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach, pixelRatio, wrappedPoints, WRAP } from "./common";

/** Warm motes that wander on slow loops and blink on and off. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const geometry = wrappedPoints(600);
  const center = new THREE.Vector3();
  const half = new THREE.Vector3(3, 1.2, 3);
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uCenter: { value: center }, uHalf: { value: half }, uColor: { value: new THREE.Color() }, uSize: { value: 1 }, uPixelRatio: { value: pixelRatio() }, uOpacity: { value: 0 }, uSpeed: { value: 1 } },
    vertexShader: /* glsl */ `
      ${WRAP}
      attribute float aSeed;
      uniform float uTime, uSize, uPixelRatio, uSpeed;
      uniform vec3 uCenter, uHalf;
      varying float vBlink;
      void main() {
        float t = uTime * uSpeed * 0.35 + aSeed * 40.0;
        vec3 p = uCenter + position * uHalf;
        p += vec3(sin(t * 0.9 + aSeed * 7.0) * 0.8, sin(t * 1.3 + aSeed * 3.0) * 0.35, cos(t * 0.7 + aSeed * 5.0) * 0.8);
        p = wrapAround(p, uCenter, uHalf);
        float phase = fract(uTime * (0.18 + aSeed * 0.22) + aSeed * 9.0);
        vBlink = smoothstep(0.0, 0.08, phase) * (1.0 - smoothstep(0.18, 0.4, phase));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uSize * uPixelRatio * clamp(60.0 / max(0.3, -mv.z), 2.0, 40.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vBlink;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float core = exp(-r * r * 60.0);
        float halo = exp(-r * r * 9.0) * 0.45;
        float alpha = (core + halo) * vBlink * uOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(uColor * (1.0 + core), alpha);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 44;
  context.scene.add(points);
  const box = new THREE.Box3();
  let active = false;

  const sync = () => {
    (material.uniforms.uColor.value as THREE.Color).set(str(params, "color", "#d8ff6a"));
    material.uniforms.uSize.value = num(params, "size", 1);
    material.uniforms.uSpeed.value = num(params, "speed", 1);
    const radius = num(params, "radius", 4);
    half.set(radius, Math.max(0.6, radius * 0.35), radius);
    geometry.setDrawRange(0, Math.round(num(params, "count", 120)));
  };
  sync();

  return {
    update({ time, delta, camera }) {
      material.uniforms.uTime.value = time;
      material.uniforms.uOpacity.value = approach(material.uniforms.uOpacity.value, active ? 1 : 0, delta, 1.5);
      points.visible = material.uniforms.uOpacity.value > 0.01;
      if (instance.target.kind === "scene" && !context.object()) {
        context.spaceBounds(box);
        center.copy(camera.position);
        center.y = box.isEmpty() ? camera.position.y - 0.4 : THREE.MathUtils.clamp(camera.position.y - 0.4, box.min.y + half.y, box.max.y);
      } else context.anchor(center);
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; sync(); },
    dispose() { context.scene.remove(points); geometry.dispose(); material.dispose(); }
  };
};

export default create;
