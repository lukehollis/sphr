import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach } from "./common";
import { splatShader } from "./splat-shader";

/** Shrinks every splat to a bright point, showing the capture as the point cloud it grew from. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const color = new THREE.Color();
  let amount = 0;
  let active = false;
  const splats = splatShader(context, { uAmount: "float", uSize: "float", uGlow: "float", uColor: "vec3" }, `
    gs.scales = mix(gs.scales, min(gs.scales, vec3(uSize)), uAmount);
    gs.rgba.a = mix(gs.rgba.a, max(gs.rgba.a, 0.95), uAmount);
    gs.rgba.rgb = mix(gs.rgba.rgb, gs.rgba.rgb * (1.0 + uGlow) + uColor * uGlow * 0.25, uAmount);
  `);
  return {
    update({ delta }) {
      if (!splats) return;
      const before = amount;
      amount = approach(amount, active ? 1 : 0, delta, 1.6);
      if (amount === before) return;
      color.set(str(params, "color", "#9fd8ff"));
      splats.values.uAmount.value = amount;
      splats.values.uSize.value = num(params, "size", 0.012);
      splats.values.uGlow.value = num(params, "glow", 0.5);
      (splats.values.uColor.value as THREE.Vector3).set(color.r, color.g, color.b);
      splats.invalidate();
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; amount = Math.min(amount, 0.999); },
    dispose() { splats?.remove(); }
  };
};

export default create;
