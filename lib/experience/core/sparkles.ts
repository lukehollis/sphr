import * as THREE from "three";
import type { EffectFactory, EffectHandle, PointerHit } from "@/lib/experience/registry";
import { num, str, waitsForCue } from "@/lib/experience/registry";

/**
 * Glints in the spirit of the garden demo's flower sparkles: additive points
 * with a soft core and four-point rays, rising and fading over a short life.
 * "aura" keeps a cloud around the target, "hover" spawns where the pointer
 * touches the space, and "burst" throws one shower when cued.
 */

const vertexShader = /* glsl */ `
  attribute float aLife;
  attribute float aSeed;
  attribute vec3 aColor;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uOpacity;
  varying float vLife;
  varying vec3 vColor;
  varying float vSeed;
  void main() {
    vLife = aLife;
    vColor = aColor;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float fade = smoothstep(0.0, 0.15, aLife) * smoothstep(1.0, 0.6, aLife);
    float perspective = clamp(110.0 / max(0.4, -mv.z), 6.0, 70.0);
    gl_PointSize = uSize * uPixelRatio * (0.6 + 0.8 * fract(aSeed * 7.31)) * fade * perspective;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uOpacity;
  uniform float uTime;
  varying float vLife;
  varying vec3 vColor;
  varying float vSeed;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p);
    float core = exp(-r * r * 90.0);
    float halo = exp(-r * r * 14.0) * 0.35;
    float twinkle = 0.65 + 0.35 * sin(uTime * 9.0 + vSeed * 40.0);
    float rays = exp(-abs(p.x) * 34.0) * exp(-abs(p.y) * 5.0) + exp(-abs(p.y) * 34.0) * exp(-abs(p.x) * 5.0);
    float alpha = (core + halo + rays * 0.55 * twinkle) * uOpacity;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(vColor * (1.2 + core), alpha);
  }
`;

type Particle = { alive: boolean; life: number; speed: number; position: THREE.Vector3; velocity: THREE.Vector3 };

const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const capacity = 400;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(capacity * 3);
  const lives = new Float32Array(capacity);
  const seeds = new Float32Array(capacity).map(() => Math.random());
  const colors = new Float32Array(capacity * 3);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("aLife", new THREE.BufferAttribute(lives, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uSize: { value: 1 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uOpacity: { value: 0 },
      uTime: { value: 0 }
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 45;
  points.name = `effect-sparkles-${instance.id}`;
  context.scene.add(points);

  const particles: Particle[] = Array.from({ length: capacity }, () => ({
    alive: false, life: 0, speed: 1, position: new THREE.Vector3(), velocity: new THREE.Vector3()
  }));
  const anchor = new THREE.Vector3();
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const colorA = new THREE.Color();
  const colorB = new THREE.Color();
  const mixed = new THREE.Color();
  let active = false;
  let opacity = 0;
  // Seconds a burst stays lit when the sparkles are not running.
  let shower = 0;
  let spawnCredit = 0;
  let hover: PointerHit | null = null;
  let hoverMoved = 0;

  const applyParams = () => {
    material.uniforms.uSize.value = num(params, "size", 1);
    colorA.set(str(params, "color", "#f7e749"));
    colorB.set(str(params, "color2", "#f3a644"));
  };
  applyParams();

  const spawn = (origin: THREE.Vector3, spread: number, upward: number, burst = false) => {
    const particle = particles.find((item) => !item.alive);
    if (!particle) return;
    particle.alive = true;
    particle.life = 0;
    particle.speed = (burst ? 0.7 : 0.35) + Math.random() * 0.5;
    const angle = Math.random() * Math.PI * 2;
    const radius = spread * Math.sqrt(Math.random());
    particle.position.set(origin.x + Math.cos(angle) * radius, origin.y + (Math.random() - 0.3) * spread * 0.6, origin.z + Math.sin(angle) * radius);
    if (burst) {
      particle.velocity.set(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(spread * (1.2 + Math.random() * 1.6));
    } else {
      particle.velocity.set((Math.random() - 0.5) * 0.08, upward * (0.15 + Math.random() * 0.35), (Math.random() - 0.5) * 0.08);
    }
    const index = particles.indexOf(particle);
    mixed.copy(colorA).lerp(colorB, Math.random());
    colors[index * 3] = mixed.r;
    colors[index * 3 + 1] = mixed.g;
    colors[index * 3 + 2] = mixed.b;
  };

  const burst = (count: number) => {
    context.anchor(anchor);
    const spread = Math.max(0.25, num(params, "radius", 0.8));
    for (let index = 0; index < count; index += 1) spawn(anchor, spread * 0.4, 1, true);
  };

  const handle: EffectHandle = {
    update({ time, delta }) {
      material.uniforms.uTime.value = time;
      shower = Math.max(0, shower - delta);
      const target = active || shower > 0 ? 1 : 0;
      opacity += (target - opacity) * Math.min(1, delta * 4);
      material.uniforms.uOpacity.value = opacity;
      const mode = str(params, "mode", "aura");
      const count = num(params, "count", 90);
      const spread = num(params, "radius", 0.8);
      if (active && mode === "aura") {
        context.anchor(anchor);
        const object = context.object();
        let radius = spread;
        if (object) {
          context.bounds(box).getSize(size);
          radius = Math.max(spread, Math.max(size.x, size.z) * 0.6);
          anchor.y = box.min.y + size.y * 0.5;
        }
        spawnCredit += delta * count * 0.7;
        while (spawnCredit >= 1) { spawn(anchor, radius, 1); spawnCredit -= 1; }
      }
      if (active && mode === "hover" && hover && hoverMoved > 0) {
        spawnCredit += delta * count * 1.6;
        while (spawnCredit >= 1) { spawn(hover.point, spread * 0.35, 1.4); spawnCredit -= 1; }
        hoverMoved = Math.max(0, hoverMoved - delta);
      }
      let alive = 0;
      for (let index = 0; index < capacity; index += 1) {
        const particle = particles[index];
        if (particle.alive) {
          particle.life += delta * particle.speed;
          if (particle.life >= 1) particle.alive = false;
          else {
            particle.velocity.y -= delta * 0.12;
            particle.velocity.multiplyScalar(1 - delta * 0.8);
            particle.position.addScaledVector(particle.velocity, delta);
            alive += 1;
          }
        }
        lives[index] = particle.alive ? particle.life : 0;
        positions[index * 3] = particle.position.x;
        positions[index * 3 + 1] = particle.position.y;
        positions[index * 3 + 2] = particle.position.z;
      }
      points.visible = alive > 0 && opacity > 0.01;
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.aLife.needsUpdate = true;
      geometry.attributes.aColor.needsUpdate = true;
    },
    setActive(value) {
      active = value;
      if (value && str(params, "mode", "aura") === "burst") burst(Math.round(num(params, "count", 90)));
    },
    play(cue) {
      // A find or a click bursts; a hint only when the sparkles burst anyway or wait for it.
      if (cue === "hint" && str(params, "mode", "aura") !== "burst" && waitsForCue(params) !== "hint") return false;
      opacity = 1;
      shower = 1.6;
      burst(cue === "found" ? 160 : Math.round(num(params, "count", 90)));
    },
    pointer(hit) {
      if (hit && (!hover || hit.point.distanceToSquared(hover.point) > 0.0004)) hoverMoved = 0.25;
      hover = hit ? { point: hit.point.clone(), normal: hit.normal?.clone() ?? null, objectId: hit.objectId } : null;
    },
    setParams(next) { params = next; applyParams(); },
    dispose() {
      context.scene.remove(points);
      geometry.dispose();
      material.dispose();
    }
  };
  return handle;
};

export default create;
