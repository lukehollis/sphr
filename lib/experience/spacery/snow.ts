import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach, pixelRatio, wrappedPoints, WRAP } from "./common";

/** Flakes falling and swaying in a box that travels with the visitor. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const geometry = wrappedPoints(6000);
  const center = new THREE.Vector3();
  const half = new THREE.Vector3(8, 4, 8);
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uCenter: { value: center }, uHalf: { value: half }, uColor: { value: new THREE.Color() }, uSize: { value: 1 }, uPixelRatio: { value: pixelRatio() }, uOpacity: { value: 0 }, uSpeed: { value: 1 }, uWind: { value: 0 } },
    vertexShader: /* glsl */ `
      ${WRAP}
      attribute float aSeed;
      uniform float uTime, uSize, uPixelRatio, uSpeed, uWind;
      uniform vec3 uCenter, uHalf;
      varying float vFade;
      void main() {
        float fall = uTime * uSpeed * (0.45 + aSeed * 0.5);
        vec3 p = position * uHalf * 3.0;
        p.y -= fall;
        p.x += sin(uTime * 0.8 + aSeed * 30.0) * 0.25 + uWind * uTime * 0.3;
        p.z += cos(uTime * 0.6 + aSeed * 20.0) * 0.25;
        vec3 w = wrapAround(p, uCenter, uHalf);
        vec3 edge = abs(w - uCenter) / uHalf;
        vFade = 1.0 - smoothstep(0.7, 1.0, max(edge.x, max(edge.y, edge.z)));
        vec4 mv = modelViewMatrix * vec4(w, 1.0);
        gl_PointSize = uSize * uPixelRatio * (0.6 + aSeed * 0.8) * clamp(28.0 / max(0.3, -mv.z), 1.0, 22.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vFade;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float alpha = smoothstep(0.5, 0.15, r) * vFade * uOpacity * 0.9;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(uColor, alpha);
      }`,
    transparent: true, depthWrite: false
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 44;
  context.scene.add(points);
  let active = false;
  const sync = () => {
    (material.uniforms.uColor.value as THREE.Color).set(str(params, "color", "#ffffff"));
    material.uniforms.uSize.value = num(params, "size", 1);
    material.uniforms.uSpeed.value = num(params, "speed", 1);
    material.uniforms.uWind.value = num(params, "wind", 0);
    const radius = num(params, "radius", 8);
    half.set(radius, Math.max(2, radius * 0.5), radius);
    geometry.setDrawRange(0, Math.round(num(params, "count", 2500)));
  };
  sync();
  return {
    update({ time, delta, camera }) {
      material.uniforms.uTime.value = time;
      material.uniforms.uOpacity.value = approach(material.uniforms.uOpacity.value, active ? 1 : 0, delta, 1.2);
      points.visible = material.uniforms.uOpacity.value > 0.01;
      if (instance.target.kind === "point" || context.object()) context.anchor(center);
      else center.copy(camera.position);
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; sync(); },
    dispose() { context.scene.remove(points); geometry.dispose(); material.dispose(); }
  };
};

export default create;
