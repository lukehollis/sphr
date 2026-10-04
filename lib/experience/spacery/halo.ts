import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { approach, glowTexture } from "./common";

/** A soft glow around an object: a rim of light on its surface and a halo behind it. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const color = new THREE.Color();
  const shellMaterial = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, uOpacity: { value: 0 }, uTime: { value: 0 }, uPulse: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vNormalView;
      varying vec3 vViewDir;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormalView = normalize(normalMatrix * normal);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity, uTime, uPulse;
      varying vec3 vNormalView;
      varying vec3 vViewDir;
      void main() {
        float rim = pow(1.0 - abs(dot(vNormalView, vViewDir)), 2.2);
        float pulse = 0.75 + 0.25 * sin(uTime * 3.0 * uPulse);
        gl_FragColor = vec4(uColor, rim * pulse * uOpacity);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  sprite.renderOrder = 34;
  sprite.raycast = () => {};
  context.scene.add(sprite);
  const shells: THREE.Mesh[] = [];
  let attachedTo: THREE.Object3D | null = null;
  const center = new THREE.Vector3();
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  let active = false;
  let flash = 0;
  /** How far the glow has faded in, 0..1; strength scales it on the way to the shaders. */
  let level = 0;

  const attach = () => {
    const object = context.object();
    if (!object || object === attachedTo) return;
    attachedTo = object;
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.haloShell) return;
      const shell = new THREE.Mesh(mesh.geometry, shellMaterial);
      shell.userData.haloShell = true;
      shell.scale.setScalar(1.03);
      shell.renderOrder = 36;
      shell.raycast = () => {};
      mesh.add(shell);
      shells.push(shell);
    });
  };

  return {
    update({ time, delta }) {
      attach();
      flash = Math.max(0, flash - delta);
      const target = active || flash > 0 ? 1 : 0;
      // Fade the level itself: scaling the stored opacity by strength every frame compounded past 1.
      level = approach(level, target, delta, 3);
      const strength = num(params, "strength", 1);
      shellMaterial.uniforms.uOpacity.value = level * strength;
      shellMaterial.uniforms.uTime.value = time;
      shellMaterial.uniforms.uPulse.value = num(params, "pulse", 1);
      color.set(str(params, "color", "#ffe9a8"));
      // The sprite keeps its own copy of the color, so it follows the param here.
      sprite.material.color.copy(color);
      sprite.material.opacity = Math.min(1, level * 0.7 * strength);
      sprite.visible = level > 0.01;
      if (!sprite.visible) return;
      context.anchor(center);
      context.bounds(box).getSize(size);
      sprite.position.copy(center);
      sprite.scale.setScalar(Math.max(0.4, size.length() * 1.6) * (0.92 + 0.08 * Math.sin(time * 2.5)));
    },
    setActive(value) { active = value; },
    // A hint keeps the object lit as long as a hint's beacon stands; a find or a click flashes.
    play(cue) { flash = cue === "hint" ? 8 : 2.5; },
    setParams(next) { params = next; },
    dispose() {
      for (const shell of shells) shell.parent?.remove(shell);
      context.scene.remove(sprite);
      sprite.material.dispose();
      shellMaterial.dispose();
    }
  };
};

export default create;
