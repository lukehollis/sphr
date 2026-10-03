import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach } from "./common";
import { screenQuad } from "./screen";

/**
 * Darkness over the whole view with a pool of light where the pointer rests,
 * for night walks and hide and seek. The light follows touches on phones.
 */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const pointer = new THREE.Vector2(0.5, 0.5);
  const target = new THREE.Vector2(0.5, 0.5);
  const projected = new THREE.Vector3();
  const quad = screenQuad(/* glsl */ `
    uniform vec2 uPointer;
    uniform float uAspect;
    uniform float uRadius;
    uniform float uDark;
    uniform float uStrength;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec2 d = vUv - uPointer;
      d.x *= uAspect;
      float r = length(d);
      float light = 1.0 - smoothstep(uRadius * 0.55, uRadius, r);
      float alpha = uDark * (1.0 - light) * uStrength;
      gl_FragColor = vec4(uTint * light * 0.0, alpha);
    }`, {
    uPointer: { value: pointer }, uAspect: { value: 1 }, uRadius: { value: 0.18 }, uDark: { value: 0.92 }, uStrength: { value: 0 }, uTint: { value: new THREE.Color("#000000") }
  });
  context.scene.add(quad);
  let active = false;
  let strength = 0;
  const canvas = context.renderer.domElement;
  const move = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    target.set((event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height);
  };
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerdown", move);
  return {
    update({ delta, camera }) {
      strength = approach(strength, active ? 1 : 0, delta, 2);
      quad.visible = strength > 0;
      if (!quad.visible) return;
      // Aimed at an object, the light rests on it until the visitor moves the pointer.
      if (instance.target.kind !== "scene" && str(params, "follow", "pointer") === "target") {
        context.anchor(projected).project(camera);
        target.set(projected.x * 0.5 + 0.5, projected.y * 0.5 + 0.5);
      }
      pointer.lerp(target, Math.min(1, delta * 10));
      quad.material.uniforms.uAspect.value = canvas.clientWidth / Math.max(1, canvas.clientHeight);
      quad.material.uniforms.uRadius.value = num(params, "radius", 0.2);
      quad.material.uniforms.uDark.value = num(params, "darkness", 0.92);
      quad.material.uniforms.uStrength.value = strength;
    },
    setActive(value) { active = value; },
    setParams(next) { params = next; },
    dispose() {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerdown", move);
      context.scene.remove(quad);
      quad.geometry.dispose();
      quad.material.dispose();
    }
  };
};

export default create;
