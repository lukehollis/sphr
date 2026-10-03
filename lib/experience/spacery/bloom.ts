import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { EffectFactory, PointerHit } from "@/lib/experience/registry";
import { bool, num, str } from "@/lib/experience/registry";
import { pixelRatio } from "./common";

/**
 * Flowers that grow where visitors hover the ground, each with a puff of
 * sparkles, as in the original garden splat tour. "patch" blooms a ring of
 * flowers around the target instead. The oldest flowers wilt as new ones grow.
 */

const GARDEN = [
  "https://static.mused.org/flower_red_v2.glb",
  "https://static.mused.org/flower_yellow.glb",
  "https://static.mused.org/flower_white.glb",
  "https://static.mused.org/flower_leaf.glb"
];

let gardenModels: Promise<THREE.Object3D[]> | null = null;
function loadGarden() {
  if (gardenModels) return gardenModels;
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
  loader.setDRACOLoader(draco);
  gardenModels = Promise.all(GARDEN.map((url) => loader.loadAsync(url).then((gltf) => gltf.scene).catch(() => null)))
    .then((models) => models.filter((model): model is THREE.Group => Boolean(model)));
  return gardenModels;
}

function simpleFlower(color: THREE.Color) {
  const group = new THREE.Group();
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.16, 6).translate(0, 0.08, 0), new THREE.MeshStandardMaterial({ color: 0x4f8a3a, roughness: 0.8 }));
  const petal = new THREE.SphereGeometry(0.03, 12, 8).scale(1, 0.35, 0.6);
  const petalMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
  for (let index = 0; index < 5; index += 1) {
    const mesh = new THREE.Mesh(petal, petalMaterial);
    const angle = index / 5 * Math.PI * 2;
    mesh.position.set(Math.cos(angle) * 0.03, 0.165, Math.sin(angle) * 0.03);
    mesh.rotation.y = -angle;
    group.add(mesh);
  }
  const center = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.4 }));
  center.position.y = 0.17;
  group.add(stem, center);
  return group;
}

type Flower = { object: THREE.Object3D; age: number; target: number; dying: number | null; key: string };

const easeInOutCubic = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const group = new THREE.Group();
  group.name = `effect-bloom-${instance.id}`;
  context.scene.add(group);
  const flowers: Flower[] = [];
  const occupied = new Set<string>();
  let models: THREE.Object3D[] = [];
  void loadGarden().then((loaded) => { models = loaded; });
  const petalColor = new THREE.Color();
  const bounds = new THREE.Box3();
  const anchor = new THREE.Vector3();
  let active = false;
  let cooldown = 0;
  let hover: PointerHit | null = null;

  // A small shower of sparks for each new flower.
  const sparkCount = 240;
  const sparkPositions = new Float32Array(sparkCount * 3);
  const sparkVelocity = new Float32Array(sparkCount * 3);
  const sparkLife = new Float32Array(sparkCount).fill(1);
  const sparkGeometry = new THREE.BufferGeometry();
  sparkGeometry.setAttribute("position", new THREE.BufferAttribute(sparkPositions, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeometry.setAttribute("aLife", new THREE.BufferAttribute(sparkLife, 1).setUsage(THREE.DynamicDrawUsage));
  const sparkMaterial = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: pixelRatio() }, uColor: { value: new THREE.Color("#fff1a8") } },
    vertexShader: /* glsl */ `
      attribute float aLife;
      uniform float uPixelRatio;
      varying float vLife;
      void main() {
        vLife = aLife;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uPixelRatio * (1.0 - aLife) * clamp(70.0 / max(0.3, -mv.z), 3.0, 40.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vLife;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float r = length(p);
        float glow = exp(-r * r * 70.0) + (exp(-abs(p.x) * 30.0) * exp(-abs(p.y) * 6.0) + exp(-abs(p.y) * 30.0) * exp(-abs(p.x) * 6.0)) * 0.5;
        float alpha = glow * (1.0 - vLife);
        if (alpha < 0.02) discard;
        gl_FragColor = vec4(uColor * 1.4, alpha);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
  const sparks = new THREE.Points(sparkGeometry, sparkMaterial);
  sparks.frustumCulled = false;
  sparks.renderOrder = 45;
  context.scene.add(sparks);
  let nextSpark = 0;

  const burst = (at: THREE.Vector3) => {
    if (!bool(params, "sparkles", true)) return;
    for (let index = 0; index < 14; index += 1) {
      const slot = nextSpark;
      nextSpark = (nextSpark + 1) % sparkCount;
      sparkPositions.set([at.x + (Math.random() - 0.5) * 0.15, at.y + 0.05 + Math.random() * 0.1, at.z + (Math.random() - 0.5) * 0.15], slot * 3);
      sparkVelocity.set([(Math.random() - 0.5) * 0.3, 0.3 + Math.random() * 0.5, (Math.random() - 0.5) * 0.3], slot * 3);
      sparkLife[slot] = 0;
    }
  };

  const grid = 0.12;
  const keyOf = (point: THREE.Vector3) => `${Math.round(point.x / grid)}_${Math.round(point.z / grid)}`;

  const grow = (point: THREE.Vector3) => {
    const key = keyOf(point);
    if (occupied.has(key)) return false;
    const size = num(params, "size", 1);
    const set = str(params, "flowers", "garden");
    petalColor.set(str(params, "color", "#ff6b9a"));
    const object = set === "garden" && models.length ? models[Math.floor(Math.random() * models.length)].clone(true) : simpleFlower(petalColor);
    object.position.copy(point);
    object.rotation.y = Math.random() * Math.PI * 2;
    object.scale.setScalar(0.0001);
    object.traverse((child) => { child.renderOrder = 35; child.raycast = () => {}; });
    group.add(object);
    flowers.push({ object, age: 0, target: size * (0.7 + Math.random() * 1.5), dying: null, key });
    occupied.add(key);
    burst(point);
    const limit = Math.round(num(params, "count", 30));
    const living = flowers.filter((flower) => flower.dying === null);
    for (let index = 0; index < living.length - limit; index += 1) living[index].dying = 0;
    return true;
  };

  const isGround = (hit: PointerHit) => {
    if (hit.normal) return hit.normal.y > 0.6;
    context.spaceBounds(bounds);
    if (bounds.isEmpty()) return true;
    return hit.point.y < bounds.min.y + (bounds.max.y - bounds.min.y) * 0.3;
  };

  const patch = () => {
    context.anchor(anchor);
    const radius = num(params, "radius", 1);
    const count = Math.round(num(params, "count", 30));
    const surfaces = context.surfaces();
    const ray = new THREE.Raycaster();
    for (let index = 0; index < count * 2 && flowers.length < count; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * radius;
      const point = new THREE.Vector3(anchor.x + Math.cos(angle) * distance, anchor.y, anchor.z + Math.sin(angle) * distance);
      if (surfaces.length) {
        ray.set(point.clone().add(new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, -1, 0));
        ray.far = 4;
        const hit = ray.intersectObjects(surfaces, true)[0];
        if (hit) point.y = hit.point.y;
      }
      grow(point);
    }
  };

  return {
    update({ delta }) {
      cooldown = Math.max(0, cooldown - delta);
      if (active && hover && cooldown === 0 && str(params, "mode", "hover") === "hover" && isGround(hover)) {
        if (grow(hover.point)) cooldown = 0.1;
      }
      for (let index = flowers.length - 1; index >= 0; index -= 1) {
        const flower = flowers[index];
        if (flower.dying !== null) {
          flower.dying += delta;
          const t = Math.min(1, flower.dying);
          flower.object.scale.setScalar(Math.max(0.0001, flower.target * (1 - easeInOutCubic(t))));
          if (t >= 1) { group.remove(flower.object); occupied.delete(flower.key); flowers.splice(index, 1); }
        } else if (flower.age < 1) {
          flower.age = Math.min(1, flower.age + delta);
          flower.object.scale.setScalar(Math.max(0.0001, flower.target * easeInOutCubic(flower.age)));
        }
      }
      for (let index = 0; index < sparkCount; index += 1) {
        if (sparkLife[index] >= 1) continue;
        sparkLife[index] = Math.min(1, sparkLife[index] + delta * 1.2);
        sparkVelocity[index * 3 + 1] -= delta * 0.4;
        sparkPositions[index * 3] += sparkVelocity[index * 3] * delta;
        sparkPositions[index * 3 + 1] += sparkVelocity[index * 3 + 1] * delta;
        sparkPositions[index * 3 + 2] += sparkVelocity[index * 3 + 2] * delta;
      }
      sparkGeometry.attributes.position.needsUpdate = true;
      sparkGeometry.attributes.aLife.needsUpdate = true;
    },
    setActive(value) {
      if (value && !active && str(params, "mode", "hover") === "patch") void loadGarden().then(() => { if (active) patch(); });
      if (!value) for (const flower of flowers) if (flower.dying === null) flower.dying = 0;
      active = value;
    },
    play() { if (str(params, "mode", "hover") === "patch") patch(); },
    pointer(hit) { hover = hit; },
    setParams(next) { params = next; },
    dispose() {
      context.scene.remove(group);
      context.scene.remove(sparks);
      sparkGeometry.dispose();
      sparkMaterial.dispose();
    }
  };
};

export default create;
