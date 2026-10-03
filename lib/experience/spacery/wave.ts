import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach } from "./common";
import { splatShader } from "./splat-shader";

/** Ripples roll out through the splats from the target like a stone dropped in water. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const origin = new THREE.Vector3();
  const color = new THREE.Color();
  let strength = 0;
  let active = false;
  const splats = splatShader(context, { uTime: "float", uOrigin: "vec3", uAmp: "float", uWave: "float", uSpeed: "float", uReach: "float", uColor: "vec3", uStrength: "float" }, `
    float wvD = distance(gs.center.xz, uOrigin.xz);
    float wvPhase = wvD / max(0.05, uWave) * 6.28318 - uTime * uSpeed;
    float wvFall = exp(-wvD / max(0.1, uReach)) * uStrength;
    float wvS = sin(wvPhase);
    gs.center.y += wvS * uAmp * wvFall;
    gs.rgba.rgb = mix(gs.rgba.rgb, uColor, smoothstep(0.7, 1.0, wvS) * wvFall * 0.35);
  `);
  return {
    update({ time, delta }) {
      if (!splats) return;
      const before = strength;
      strength = approach(strength, active ? 1 : 0, delta, 1.5);
      if (strength === 0 && before === 0) return;
      context.anchor(origin);
      color.set(str(params, "color", "#bfe9ff"));
      splats.values.uTime.value = time;
      (splats.values.uOrigin.value as THREE.Vector3).copy(origin);
      splats.values.uAmp.value = num(params, "height", 0.15);
      splats.values.uWave.value = num(params, "wavelength", 1.5);
      splats.values.uSpeed.value = num(params, "speed", 3);
      splats.values.uReach.value = num(params, "reach", 6);
      (splats.values.uColor.value as THREE.Vector3).set(color.r, color.g, color.b);
      splats.values.uStrength.value = strength;
      splats.invalidate();
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; },
    dispose() { splats?.remove(); }
  };
};

export default create;
