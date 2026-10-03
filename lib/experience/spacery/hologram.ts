import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach } from "./common";
import { splatShader } from "./splat-shader";
import { surfaceOverlay } from "./surface-overlay";

/** Turns the space, or a sphere of it, into a flickering projection with scan lines. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const color = new THREE.Color();
  const origin = new THREE.Vector3();
  let strength = 0;
  let active = false;
  const splats = splatShader(context, { uTime: "float", uOrigin: "vec3", uRadius: "float", uLines: "float", uColor: "vec3", uStrength: "float" }, `
    float hoWithin = uRadius <= 0.0 ? 1.0 : 1.0 - smoothstep(uRadius * 0.8, uRadius, distance(gs.center, uOrigin));
    float hoLum = dot(gs.rgba.rgb, vec3(0.299, 0.587, 0.114));
    float hoBand = 0.55 + 0.45 * step(0.5, fract(gs.center.y * uLines - uTime * 0.5));
    float hoFlicker = 1.0 - 0.35 * step(0.96, fract(sin(floor(uTime * 18.0) * 12.9898) * 43758.5453));
    vec3 hoColor = uColor * (0.25 + hoLum * 1.4) * hoBand * hoFlicker;
    float hoMix = hoWithin * uStrength;
    gs.rgba.rgb = mix(gs.rgba.rgb, hoColor, hoMix);
    gs.rgba.a *= mix(1.0, 0.7, hoMix);
  `);
  const overlay = surfaceOverlay(context, `
    float within = uRadius <= 0.0 ? 1.0 : 1.0 - smoothstep(uRadius * 0.8, uRadius, distance(vWorld, uOrigin));
    float line = smoothstep(0.85, 1.0, abs(sin(vWorld.y * uLines * 3.14159 - uTime * 1.5)));
    float sweep = smoothstep(0.0, 0.05, fract(vWorld.y * 0.25 - uTime * 0.2)) * (1.0 - smoothstep(0.05, 0.25, fract(vWorld.y * 0.25 - uTime * 0.2)));
    alpha = (line * 0.22 + sweep * 0.25 + 0.05) * within * uStrength;
    color = uColor;
  `, { uTime: { value: 0 }, uLines: { value: 6 }, uRadius: { value: 0 }, uOrigin: { value: origin }, uColor: { value: color }, uStrength: { value: 0 } });
  const sync = () => {
    color.set(str(params, "color", "#53e3ff"));
    overlay.material.uniforms.uLines.value = num(params, "lines", 6);
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
        splats.values.uLines.value = num(params, "lines", 6);
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
