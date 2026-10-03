import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach, pixelRatio } from "./common";

/** Bright motes circling the target on tilted rings, each with a short comet tail. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const tail = 10;
  const motes = 24;
  const count = motes * tail;
  const geometry = new THREE.BufferGeometry();
  const ring = new Float32Array(count), offset = new Float32Array(count), trail = new Float32Array(count);
  for (let mote = 0; mote < motes; mote += 1) for (let index = 0; index < tail; index += 1) {
    const vertex = mote * tail + index;
    ring[vertex] = mote % 3;
    offset[vertex] = mote / motes * Math.PI * 2 * 3.1;
    trail[vertex] = index / tail;
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("aRing", new THREE.BufferAttribute(ring, 1));
  geometry.setAttribute("aOffset", new THREE.BufferAttribute(offset, 1));
  geometry.setAttribute("aTrail", new THREE.BufferAttribute(trail, 1));
  const center = new THREE.Vector3();
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uCenter: { value: center }, uRadius: { value: 0.6 }, uSpeed: { value: 1 }, uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uPixelRatio: { value: pixelRatio() }, uSize: { value: 1 }, uMotes: { value: 12 } },
    vertexShader: /* glsl */ `
      attribute float aRing, aOffset, aTrail;
      uniform float uTime, uRadius, uSpeed, uPixelRatio, uSize, uMotes;
      uniform vec3 uCenter;
      varying float vTrail;
      varying float vShow;
      void main() {
        vTrail = aTrail;
        vShow = step(aOffset / (6.28318 * 3.1) * 24.0, uMotes - 0.5);
        float a = uTime * uSpeed * (1.0 + aRing * 0.25) + aOffset - aTrail * 0.35;
        float tilt = aRing * 1.05 + 0.35;
        vec3 p = vec3(cos(a), 0.0, sin(a)) * uRadius * (1.0 + aRing * 0.18);
        p = vec3(p.x, p.z * sin(tilt), p.z * cos(tilt));
        float c = cos(aRing * 2.1), s = sin(aRing * 2.1);
        p = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
        vec4 mv = modelViewMatrix * vec4(uCenter + p, 1.0);
        gl_PointSize = uSize * uPixelRatio * (1.0 - aTrail * 0.8) * clamp(55.0 / max(0.3, -mv.z), 2.0, 30.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vTrail;
      varying float vShow;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float alpha = exp(-r * r * 20.0) * (1.0 - vTrail) * uOpacity * vShow;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(uColor * 1.4, alpha);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 46;
  context.scene.add(points);
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  let active = false;
  return {
    update({ time, delta }) {
      material.uniforms.uOpacity.value = approach(material.uniforms.uOpacity.value, active ? 1 : 0, delta, 2);
      points.visible = material.uniforms.uOpacity.value > 0.01;
      if (!points.visible) return;
      material.uniforms.uTime.value = time;
      (material.uniforms.uColor.value as THREE.Color).set(str(params, "color", "#9ff3ff"));
      material.uniforms.uSpeed.value = num(params, "speed", 1);
      material.uniforms.uMotes.value = num(params, "count", 12);
      context.anchor(center);
      let radius = num(params, "radius", 0.5);
      if (context.object()) { context.bounds(box).getSize(size); radius = Math.max(radius, Math.max(size.x, size.z) * 0.75); }
      material.uniforms.uRadius.value = radius;
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; },
    dispose() { context.scene.remove(points); geometry.dispose(); material.dispose(); }
  };
};

export default create;
