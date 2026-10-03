import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach } from "./common";
import { splatShader } from "./splat-shader";
import { surfaceOverlay } from "./surface-overlay";

/** Points of light twinkle across the capture, like frost or fairy dust. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const color = new THREE.Color();
  const origin = new THREE.Vector3();
  let strength = 0;
  let active = false;
  const splats = splatShader(context, { uTime: "float", uOrigin: "vec3", uRadius: "float", uAmount: "float", uColor: "vec3", uStrength: "float" }, `
    float glPhase = fract(sin(dot(gs.center, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float glPick = fract(sin(dot(gs.center, vec3(39.346, 11.135, 83.155))) * 24634.6345);
    float glWithin = uRadius <= 0.0 ? 1.0 : 1.0 - smoothstep(uRadius * 0.75, uRadius, distance(gs.center, uOrigin));
    float glTwinkle = pow(max(0.0, sin(uTime * (1.5 + glPhase * 3.0) + glPhase * 60.0)), 28.0) * step(1.0 - uAmount, glPick);
    float glAmount = glTwinkle * glWithin * uStrength;
    gs.rgba.rgb = mix(gs.rgba.rgb, uColor * 2.2, glAmount * 0.85);
    gs.rgba.a = max(gs.rgba.a, glAmount);
    gs.scales *= 1.0 + glAmount * 0.8;
  `);
  const overlay = surfaceOverlay(context, `
    vec3 cell = floor(vWorld * uDensity);
    float phase = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float pick = fract(sin(dot(cell, vec3(39.346, 11.135, 83.155))) * 24634.6345);
    vec3 local = fract(vWorld * uDensity) - 0.5;
    float dotShape = exp(-dot(local, local) * 40.0);
    float twinkle = pow(max(0.0, sin(uTime * (1.5 + phase * 3.0) + phase * 60.0)), 20.0) * step(1.0 - uAmount, pick);
    float within = uRadius <= 0.0 ? 1.0 : 1.0 - smoothstep(uRadius * 0.75, uRadius, distance(vWorld, uOrigin));
    alpha = dotShape * twinkle * within * uStrength;
    color = uColor * 1.8;
  `, { uTime: { value: 0 }, uDensity: { value: 9 }, uAmount: { value: 0.1 }, uRadius: { value: 0 }, uOrigin: { value: origin }, uColor: { value: color }, uStrength: { value: 0 } });

  const sync = () => {
    color.set(str(params, "color", "#fff6da"));
    overlay.material.uniforms.uAmount.value = num(params, "amount", 0.1);
    overlay.material.uniforms.uRadius.value = num(params, "radius", 0);
  };
  sync();

  return {
    update({ time, delta }) {
      strength = approach(strength, active ? 1 : 0, delta, 2);
      if (instance.target.kind !== "scene" || context.object()) context.anchor(origin);
      overlay.material.uniforms.uTime.value = time;
      overlay.material.uniforms.uStrength.value = strength;
      overlay.update(strength > 0);
      if (splats && strength > 0) {
        splats.values.uTime.value = time;
        (splats.values.uOrigin.value as THREE.Vector3).copy(origin);
        splats.values.uRadius.value = num(params, "radius", 0);
        splats.values.uAmount.value = num(params, "amount", 0.1);
        (splats.values.uColor.value as THREE.Vector3).set(color.r, color.g, color.b);
        splats.values.uStrength.value = strength;
        splats.invalidate();
      }
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; sync(); },
    dispose() { splats?.remove(); overlay.dispose(); }
  };
};

export default create;
