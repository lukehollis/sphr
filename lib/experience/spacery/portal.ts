import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach, NOISE } from "./common";

/** A swirling doorway of light standing at the target and turning to face the visitor. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const inner = new THREE.Color();
  const rim = new THREE.Color();
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uInner: { value: inner }, uRim: { value: rim }, uOpacity: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      ${NOISE}
      uniform vec3 uInner, uRim;
      uniform float uTime, uOpacity;
      varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * vec2(2.0, 2.0);
        p.x *= 1.35;
        float r = length(p);
        float angle = atan(p.y, p.x);
        float swirl = snoise(vec3(cos(angle + r * 4.0 - uTime * 1.2) * r * 2.0, sin(angle + r * 4.0 - uTime * 1.2) * r * 2.0, uTime * 0.25));
        float body = 1.0 - smoothstep(0.82, 1.0, r);
        float edge = exp(-pow((r - 0.92) * 14.0, 2.0)) * (0.8 + 0.4 * snoise(vec3(angle * 3.0, uTime, 0.0)));
        vec3 color = mix(uInner * (0.55 + 0.45 * swirl), uRim, edge);
        float alpha = (body * (0.55 + 0.35 * swirl) + edge * 1.4) * uOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1.35), material);
  mesh.renderOrder = 46;
  context.scene.add(mesh);
  const anchor = new THREE.Vector3();
  const box = new THREE.Box3();
  let active = false;
  return {
    update({ time, delta, camera }) {
      material.uniforms.uOpacity.value = approach(material.uniforms.uOpacity.value, active ? 1 : 0, delta, 1.5);
      mesh.visible = material.uniforms.uOpacity.value > 0.01;
      if (!mesh.visible) return;
      material.uniforms.uTime.value = time;
      inner.set(str(params, "color", "#7a5cff"));
      rim.set(str(params, "rim", "#9ff3ff"));
      const size = num(params, "size", 2);
      context.anchor(anchor);
      if (context.object()) { context.bounds(box); anchor.y = box.min.y; }
      mesh.scale.setScalar(size);
      mesh.position.set(anchor.x, anchor.y + size * 0.675, anchor.z);
      mesh.rotation.set(0, Math.atan2(camera.position.x - anchor.x, camera.position.z - anchor.z), 0);
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; },
    dispose() { context.scene.remove(mesh); mesh.geometry.dispose(); material.dispose(); }
  };
};

export default create;
