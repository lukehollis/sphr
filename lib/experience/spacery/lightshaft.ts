import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach, NOISE } from "./common";

/** A shaft of light falling on the target from above, with motes turning in it. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const color = new THREE.Color();
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: color }, uOpacity: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalView;
      varying vec3 vViewDir;
      varying vec3 vLocal;
      void main() {
        vUv = uv;
        vLocal = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormalView = normalize(normalMatrix * normal);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${NOISE}
      uniform vec3 uColor;
      uniform float uTime, uOpacity;
      varying vec2 vUv;
      varying vec3 vNormalView;
      varying vec3 vViewDir;
      varying vec3 vLocal;
      void main() {
        float facing = pow(abs(dot(vNormalView, vViewDir)), 1.5);
        float fadeEnds = smoothstep(0.0, 0.25, vUv.y) * smoothstep(1.0, 0.7, vUv.y);
        float motes = smoothstep(0.55, 0.9, snoise(vec3(vLocal.x * 6.0, vLocal.y * 3.0 - uTime * 0.25, vLocal.z * 6.0)));
        float streaks = 0.7 + 0.3 * snoise(vec3(atan(vLocal.x, vLocal.z) * 3.0, uTime * 0.1, 0.0));
        float alpha = (facing * 0.35 * streaks + motes * 0.25) * fadeEnds * uOpacity;
        gl_FragColor = vec4(uColor, alpha);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 1, 1, 48, 1, true).translate(0, 0.5, 0), material);
  mesh.renderOrder = 46;
  context.scene.add(mesh);
  const anchor = new THREE.Vector3();
  const box = new THREE.Box3();
  let active = false;
  return {
    update({ time, delta }) {
      material.uniforms.uOpacity.value = approach(material.uniforms.uOpacity.value, active ? 1 : 0, delta, 1.2);
      mesh.visible = material.uniforms.uOpacity.value > 0.01;
      if (!mesh.visible) return;
      material.uniforms.uTime.value = time;
      color.set(str(params, "color", "#fff3d1"));
      context.anchor(anchor);
      if (context.object()) { context.bounds(box); anchor.y = box.min.y; }
      const radius = num(params, "radius", 0.8);
      mesh.position.copy(anchor);
      mesh.scale.set(radius, num(params, "height", 6), radius);
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; },
    dispose() { context.scene.remove(mesh); mesh.geometry.dispose(); material.dispose(); }
  };
};

export default create;
