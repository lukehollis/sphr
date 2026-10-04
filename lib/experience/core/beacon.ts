import * as THREE from "three";
import type { EffectFactory, EffectHandle } from "@/lib/experience/registry";
import { num, str, waitsForCue } from "@/lib/experience/registry";

/** A soft light column with rings rippling out on the ground beneath it. */

const columnVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalView = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const columnFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewDir;
  void main() {
    float rim = pow(1.0 - abs(dot(vNormalView, vViewDir)), 0.6);
    float fade = pow(1.0 - vUv.y, 1.6);
    float flow = 0.75 + 0.25 * sin(vUv.y * 24.0 - uTime * 3.0);
    float alpha = (1.0 - rim) * fade * flow * uOpacity * 0.55;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

const ringFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uPulse;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float alpha = 0.0;
    for (int i = 0; i < 3; i++) {
      float phase = fract(uTime * uPulse * 0.5 + float(i) / 3.0);
      float ring = 1.0 - smoothstep(0.0, 0.05, abs(r - phase));
      alpha += ring * (1.0 - phase);
    }
    alpha += (1.0 - smoothstep(0.0, 0.18, r)) * 0.6;
    alpha *= uOpacity * step(r, 1.0);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

const ringVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const group = new THREE.Group();
  group.name = `effect-beacon-${instance.id}`;
  const color = new THREE.Color();
  const shared = { uColor: { value: color }, uOpacity: { value: 0 }, uTime: { value: 0 }, uPulse: { value: 1 } };
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 40, 1, true).translate(0, 0.5, 0),
    new THREE.ShaderMaterial({ vertexShader: columnVertex, fragmentShader: columnFragment, uniforms: shared, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
  );
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({ vertexShader: ringVertex, fragmentShader: ringFragment, uniforms: shared, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
  );
  column.renderOrder = 46;
  ring.renderOrder = 46;
  ring.position.y = 0.02;
  group.add(column, ring);
  context.scene.add(group);
  const anchor = new THREE.Vector3();
  // Where a cue lit it while the beacon is not running, kept as a found object flies off.
  const spot = new THREE.Vector3();
  const box = new THREE.Box3();
  let active = false;
  let pinned = false;
  let hold = 0;
  const base = (out: THREE.Vector3) => {
    context.anchor(out);
    if (context.object()) { context.bounds(box); out.y = box.min.y; }
    return out;
  };

  const sync = () => {
    color.set(str(params, "color", "#ffffff"));
    shared.uPulse.value = num(params, "pulse", 1);
    const radius = num(params, "radius", 0.5);
    column.scale.set(radius * 0.45, num(params, "height", 4), radius * 0.45);
    ring.scale.setScalar(radius * 1.6);
  };
  sync();

  const handle: EffectHandle = {
    update({ time, delta }) {
      shared.uTime.value = time;
      hold = Math.max(0, hold - delta);
      const target = active || hold > 0 ? 1 : 0;
      shared.uOpacity.value += (target - shared.uOpacity.value) * Math.min(1, delta * 3);
      group.visible = shared.uOpacity.value > 0.01;
      if (!group.visible) return;
      group.position.copy(pinned ? spot : base(anchor));
    },
    setActive(value) { active = value; if (value) pinned = false; },
    play(cue) {
      // It lights the way for a hint or a click; a find only when it waits for one.
      if (cue === "found" && waitsForCue(params) !== "found") return false;
      hold = 8;
      if (!active) { base(spot); pinned = true; }
    },
    setParams(next) { params = next; sync(); },
    dispose() {
      context.scene.remove(group);
      column.geometry.dispose();
      ring.geometry.dispose();
      (column.material as THREE.Material).dispose();
      (ring.material as THREE.Material).dispose();
    }
  };
  return handle;
};

export default create;
