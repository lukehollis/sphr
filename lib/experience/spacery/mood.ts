import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach } from "./common";
import { screenQuad } from "./screen";

const MOODS: Record<string, { top: string; bottom: string; alpha: number; vignette: number; shimmer: number }> = {
  night: { top: "#0b1640", bottom: "#05070f", alpha: 0.55, vignette: 0.75, shimmer: 0 },
  golden: { top: "#ffb347", bottom: "#ff6f3c", alpha: 0.22, vignette: 0.35, shimmer: 0 },
  dream: { top: "#ffc6e4", bottom: "#b8c6ff", alpha: 0.24, vignette: 0.45, shimmer: 0.4 },
  noir: { top: "#1b1f24", bottom: "#000000", alpha: 0.38, vignette: 0.9, shimmer: 0 },
  underwater: { top: "#2bb3c4", bottom: "#05345a", alpha: 0.36, vignette: 0.6, shimmer: 1 },
  ember: { top: "#ff3b1f", bottom: "#2b0700", alpha: 0.28, vignette: 0.7, shimmer: 0.3 }
};

/** A color mood over the whole view: night, golden hour, dream, noir, underwater or ember. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const top = new THREE.Color();
  const bottom = new THREE.Color();
  const quad = screenQuad(/* glsl */ `
    uniform vec3 uTop;
    uniform vec3 uBottom;
    uniform float uAlpha;
    uniform float uVignette;
    uniform float uShimmer;
    uniform float uTime;
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      vec3 tint = mix(uBottom, uTop, vUv.y);
      vec2 c = vUv - 0.5;
      float vignette = smoothstep(0.25, 0.85, length(c) * 1.25) * uVignette;
      float caustic = uShimmer * 0.12 * (sin(vUv.x * 40.0 + uTime * 1.3 + sin(vUv.y * 30.0 + uTime)) * 0.5 + 0.5) * (sin(vUv.y * 36.0 - uTime * 1.1) * 0.5 + 0.5);
      float alpha = clamp(uAlpha + vignette * 0.85, 0.0, 0.97) * uStrength;
      vec3 color = mix(tint, vec3(0.0), vignette) + caustic;
      gl_FragColor = vec4(color, alpha);
    }`, {
    uTop: { value: top }, uBottom: { value: bottom }, uAlpha: { value: 0.4 }, uVignette: { value: 0.5 }, uShimmer: { value: 0 }, uTime: { value: 0 }, uStrength: { value: 0 }
  });
  context.scene.add(quad);
  let active = false;
  let strength = 0;
  const sync = () => {
    const mood = MOODS[str(params, "mood", "night")] ?? MOODS.night;
    const intensity = num(params, "intensity", 1);
    top.set(mood.top); bottom.set(mood.bottom);
    quad.material.uniforms.uAlpha.value = mood.alpha * intensity;
    quad.material.uniforms.uVignette.value = mood.vignette * intensity;
    quad.material.uniforms.uShimmer.value = mood.shimmer;
  };
  sync();
  return {
    update({ time, delta }) {
      strength = approach(strength, active ? 1 : 0, delta, 1.2);
      quad.visible = strength > 0;
      quad.material.uniforms.uStrength.value = strength;
      quad.material.uniforms.uTime.value = time;
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; sync(); },
    dispose() { context.scene.remove(quad); quad.geometry.dispose(); quad.material.dispose(); }
  };
};

export default create;
