import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach, WRAP } from "./common";

/** Streaks of rain, drawn as short lines that fall fast around the visitor. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const capacity = 6000;
  const positions = new Float32Array(capacity * 2 * 3);
  const ends = new Float32Array(capacity * 2);
  const seeds = new Float32Array(capacity * 2);
  for (let index = 0; index < capacity; index += 1) {
    const x = Math.random() * 2 - 1, y = Math.random() * 2 - 1, z = Math.random() * 2 - 1, seed = Math.random();
    for (let end = 0; end < 2; end += 1) {
      const vertex = index * 2 + end;
      positions.set([x, y, z], vertex * 3);
      ends[vertex] = end;
      seeds[vertex] = seed;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aEnd", new THREE.BufferAttribute(ends, 1));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  const center = new THREE.Vector3();
  const half = new THREE.Vector3(8, 5, 8);
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uCenter: { value: center }, uHalf: { value: half }, uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uSpeed: { value: 1 }, uWind: { value: 0 } },
    vertexShader: /* glsl */ `
      ${WRAP}
      attribute float aEnd;
      attribute float aSeed;
      uniform float uTime, uSpeed, uWind;
      uniform vec3 uCenter, uHalf;
      varying float vAlpha;
      void main() {
        float speed = uSpeed * (7.0 + aSeed * 4.0);
        vec3 p = position * uHalf * 3.0;
        p.y -= uTime * speed;
        p.x += uTime * uWind;
        vec3 w = wrapAround(p, uCenter, uHalf);
        vec3 dir = normalize(vec3(uWind, -speed, 0.0));
        w += dir * aEnd * (0.18 + aSeed * 0.2) * uSpeed;
        vec3 edge = abs(w - uCenter) / uHalf;
        vAlpha = (1.0 - smoothstep(0.75, 1.0, max(edge.x, max(edge.y, edge.z)))) * mix(0.0, 1.0, aEnd);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlpha;
      void main() { gl_FragColor = vec4(uColor, vAlpha * uOpacity * 0.45); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = 44;
  context.scene.add(lines);
  let active = false;
  const sync = () => {
    (material.uniforms.uColor.value as THREE.Color).set(str(params, "color", "#b9c8d6"));
    material.uniforms.uSpeed.value = num(params, "speed", 1);
    material.uniforms.uWind.value = num(params, "wind", 0.5);
    const radius = num(params, "radius", 8);
    half.set(radius, Math.max(3, radius * 0.6), radius);
    geometry.setDrawRange(0, Math.round(num(params, "count", 2500)) * 2);
  };
  sync();
  return {
    update({ time, delta, camera }) {
      material.uniforms.uTime.value = time;
      material.uniforms.uOpacity.value = approach(material.uniforms.uOpacity.value, active ? 1 : 0, delta, 1.5);
      lines.visible = material.uniforms.uOpacity.value > 0.01;
      center.copy(camera.position);
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; sync(); },
    dispose() { context.scene.remove(lines); geometry.dispose(); material.dispose(); }
  };
};

export default create;
