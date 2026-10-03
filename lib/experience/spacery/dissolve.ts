import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { splatShader } from "./splat-shader";

/**
 * The capture crumbles into drifting sand and gathers back together, splat by
 * splat in a staggered wave. "out" dissolves while the stop is shown, "in"
 * assembles the space from sand, "cycle" breathes between the two.
 */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const sand = new THREE.Color();
  const origin = new THREE.Vector3();
  let progress = 0;
  let target = 0;
  let active = false;
  let clock = 0;
  const splats = splatShader(context, { uProgress: "float", uTime: "float", uOrigin: "vec3", uColor: "vec3" }, `
    float dsH = fract(sin(dot(gs.center, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float dsReach = clamp(distance(gs.center, uOrigin) / 12.0, 0.0, 1.0);
    float dsLocal = clamp(uProgress * 1.8 - (dsH * 0.5 + dsReach * 0.3), 0.0, 1.0);
    float dsEase = dsLocal * dsLocal;
    vec3 dsDrift = vec3(sin(dsH * 91.0 + uTime * 0.7) * 0.9, 0.5 + dsH * 1.4, cos(dsH * 57.0 + uTime * 0.6) * 0.9);
    gs.center += dsDrift * dsEase * 1.8;
    gs.scales *= mix(1.0, 0.18, smoothstep(0.0, 0.7, dsLocal));
    gs.rgba.rgb = mix(gs.rgba.rgb, uColor * (0.8 + dsH * 0.5), smoothstep(0.0, 0.45, dsLocal));
    gs.rgba.a *= 1.0 - smoothstep(0.65, 1.0, dsLocal);
  `);

  const mode = () => str(params, "mode", "out");
  return {
    update({ time, delta }) {
      if (!splats) return;
      const duration = Math.max(0.5, num(params, "duration", 4));
      if (active && mode() === "cycle") {
        clock += delta;
        target = Math.sin(clock / duration * Math.PI) > 0 ? 1 : 0;
      }
      const before = progress;
      const step = delta / duration;
      progress = progress < target ? Math.min(target, progress + step) : Math.max(target, progress - step);
      if (progress === before && progress === 0) return;
      context.anchor(origin);
      splats.values.uProgress.value = progress;
      splats.values.uTime.value = time;
      (splats.values.uOrigin.value as THREE.Vector3).copy(origin);
      sand.set(str(params, "color", "#d9c39a"));
      (splats.values.uColor.value as THREE.Vector3).set(sand.r, sand.g, sand.b);
      splats.invalidate();
    },
    setActive(value) {
      active = value;
      clock = 0;
      if (mode() === "in") { if (value) { progress = 1; target = 0; } }
      else target = value ? 1 : 0;
    },
    play() { progress = 1; target = 0; },
    setParams(next) { params = next; },
    dispose() { splats?.remove(); }
  };
};

export default create;
