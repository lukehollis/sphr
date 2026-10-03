import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach, floorBelow, NOISE } from "./common";

/** Low banks of mist drifting along the floor around the target or the visitor. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const layers = 18;
  const color = new THREE.Color();
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: color }, uOpacity: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      varying vec2 vUv;
      varying float vSeed;
      void main() {
        vUv = uv;
        vSeed = aSeed;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${NOISE}
      uniform vec3 uColor;
      uniform float uTime, uOpacity;
      varying vec2 vUv;
      varying float vSeed;
      void main() {
        vec2 p = vUv - 0.5;
        float edge = 1.0 - smoothstep(0.25, 0.5, length(p));
        float n = snoise(vec3(vUv * 2.5 + vSeed * 10.0, uTime * 0.05 + vSeed)) * 0.5 + 0.5;
        n *= snoise(vec3(vUv * 5.0 - vSeed * 7.0, uTime * 0.08)) * 0.35 + 0.65;
        float alpha = edge * n * uOpacity * 0.22;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(uColor, alpha);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide
  });
  const geometry = new THREE.PlaneGeometry(1, 1);
  const seeds = new Float32Array(layers).map(() => Math.random());
  geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
  const mesh = new THREE.InstancedMesh(geometry, material, layers);
  mesh.frustumCulled = false;
  mesh.renderOrder = 43;
  context.scene.add(mesh);
  const offsets = Array.from({ length: layers }, () => ({ x: Math.random() * 2 - 1, z: Math.random() * 2 - 1, y: Math.random(), speed: 0.05 + Math.random() * 0.1, angle: Math.random() * Math.PI * 2 }));
  const center = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  let floorY: number | null = null;
  let active = false;
  return {
    update({ time, delta, camera }) {
      const opacity = approach(material.uniforms.uOpacity.value, active ? num(params, "density", 1) : 0, delta, 0.8);
      material.uniforms.uOpacity.value = opacity;
      material.uniforms.uTime.value = time;
      mesh.visible = opacity > 0.01;
      if (!mesh.visible) return;
      color.set(str(params, "color", "#e8eef2"));
      if (instance.target.kind === "scene" && !context.object()) center.copy(camera.position);
      else context.anchor(center);
      if (floorY === null) floorY = floorBelow(center, context.surfaces(), center.y - 1.6);
      const radius = num(params, "radius", 6);
      const height = num(params, "height", 0.6);
      for (let index = 0; index < layers; index += 1) {
        const offset = offsets[index];
        const drift = time * offset.speed;
        position.set(center.x + (offset.x + Math.sin(drift + offset.angle) * 0.2) * radius, floorY + 0.05 + offset.y * height, center.z + (offset.z + Math.cos(drift * 0.8 + offset.angle) * 0.2) * radius);
        quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, offset.angle + drift * 0.3));
        scale.set(radius * 1.2, radius * 1.2, 1);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; floorY = null; },
    dispose() { context.scene.remove(mesh); geometry.dispose(); material.dispose(); mesh.dispose(); }
  };
};

export default create;
