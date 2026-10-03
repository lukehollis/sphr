import * as THREE from "three";
import type { EffectFactory, EffectHandle } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";

/** Motes drifting on slow curl-like noise, moved entirely in the vertex shader. */

const vertexShader = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform vec3 uCenter;
  uniform vec3 uHalf;
  varying float vSeed;
  varying float vFade;
  void main() {
    vSeed = aSeed;
    float t = uTime * uSpeed * 0.18;
    vec3 p = position;
    p.x += sin(t * 1.3 + aSeed * 31.0) * 0.6 + sin(t * 0.37 + p.y * 0.7) * 0.9;
    p.y += sin(t * 0.9 + aSeed * 17.0) * 0.35 + t * 0.12 * (0.5 + aSeed);
    p.z += cos(t * 1.1 + aSeed * 23.0) * 0.6 + cos(t * 0.41 + p.x * 0.6) * 0.9;
    vec3 local = mod(p - uCenter + uHalf, uHalf * 2.0) - uHalf;
    vec3 edge = abs(local) / max(uHalf, vec3(0.001));
    vFade = 1.0 - smoothstep(0.75, 1.0, max(edge.x, max(edge.y, edge.z)));
    vec4 mv = modelViewMatrix * vec4(uCenter + local, 1.0);
    gl_PointSize = uSize * uPixelRatio * (0.5 + aSeed) * clamp(40.0 / max(0.3, -mv.z), 1.5, 26.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  varying float vSeed;
  varying float vFade;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    float alpha = smoothstep(0.5, 0.0, r);
    alpha *= alpha * uOpacity * vFade * (0.55 + 0.45 * sin(uTime * (0.6 + vSeed) + vSeed * 50.0));
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor, alpha * 0.8);
  }
`;

const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const capacity = 3000;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(capacity * 3);
  const seeds = new Float32Array(capacity);
  for (let index = 0; index < capacity; index += 1) {
    positions[index * 3] = Math.random() * 2 - 1;
    positions[index * 3 + 1] = Math.random() * 2 - 1;
    positions[index * 3 + 2] = Math.random() * 2 - 1;
    seeds[index] = Math.random();
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  const center = new THREE.Vector3();
  const half = new THREE.Vector3(4, 2, 4);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uSpeed: { value: 0.4 },
      uSize: { value: 1 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uCenter: { value: center },
      uHalf: { value: half },
      uColor: { value: new THREE.Color() },
      uOpacity: { value: 0 }
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 44;
  points.name = `effect-dust-${instance.id}`;
  context.scene.add(points);

  const box = new THREE.Box3();
  let active = false;
  let opacity = 0;
  let laidOut = -1;

  const layout = () => {
    const radius = num(params, "radius", 8);
    const follow = instance.target.kind === "scene" && !context.object();
    if (follow) {
      context.spaceBounds(box);
      const size = box.isEmpty() ? new THREE.Vector3(radius * 2, radius, radius * 2) : box.getSize(new THREE.Vector3());
      half.set(Math.min(radius, size.x / 2 || radius), Math.min(radius * 0.5, Math.max(1.5, size.y / 2)), Math.min(radius, size.z / 2 || radius));
    } else half.set(radius, Math.max(0.6, radius * 0.5), radius);
    for (let index = 0; index < capacity; index += 1) {
      positions[index * 3] = (Math.random() * 2 - 1) * half.x;
      positions[index * 3 + 1] = (Math.random() * 2 - 1) * half.y;
      positions[index * 3 + 2] = (Math.random() * 2 - 1) * half.z;
    }
    geometry.attributes.position.needsUpdate = true;
    laidOut = radius;
  };

  const sync = () => {
    material.uniforms.uSpeed.value = num(params, "speed", 0.4);
    material.uniforms.uSize.value = num(params, "size", 1);
    (material.uniforms.uColor.value as THREE.Color).set(str(params, "color", "#efe2d6"));
    geometry.setDrawRange(0, Math.round(num(params, "count", 600)));
    if (laidOut !== num(params, "radius", 8)) layout();
  };
  sync();

  const handle: EffectHandle = {
    update({ time, delta, camera }) {
      material.uniforms.uTime.value = time;
      opacity += ((active ? 1 : 0) - opacity) * Math.min(1, delta * 2);
      material.uniforms.uOpacity.value = opacity;
      points.visible = opacity > 0.01;
      // Space-wide dust stays centered near the visitor so it fills every room.
      if (instance.target.kind === "scene" && !context.object()) {
        context.spaceBounds(box);
        center.copy(camera.position);
        if (!box.isEmpty()) center.clamp(box.min, box.max);
        center.y = THREE.MathUtils.clamp(camera.position.y, box.isEmpty() ? -Infinity : box.min.y + half.y * 0.5, box.isEmpty() ? Infinity : box.max.y);
      } else context.anchor(center);
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; sync(); },
    dispose() {
      context.scene.remove(points);
      geometry.dispose();
      material.dispose();
    }
  };
  return handle;
};

export default create;
