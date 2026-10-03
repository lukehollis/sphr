import * as THREE from "three";
import type { EffectFactory } from "@/lib/experience/registry";
import { num, str } from "@/lib/experience/registry";
import { PALETTES } from "./common";

type Piece = { alive: boolean; life: number; position: THREE.Vector3; velocity: THREE.Vector3; spin: THREE.Vector3; rotation: THREE.Euler };

/** Paper confetti thrown from the target, tumbling and fluttering down. */
const create: EffectFactory = (context, instance) => {
  let params = instance.params;
  const capacity = 400;
  const geometry = new THREE.PlaneGeometry(0.035, 0.055);
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, toneMapped: false });
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 45;
  mesh.count = 0;
  context.scene.add(mesh);
  const pieces: Piece[] = Array.from({ length: capacity }, () => ({ alive: false, life: 0, position: new THREE.Vector3(), velocity: new THREE.Vector3(), spin: new THREE.Vector3(), rotation: new THREE.Euler() }));
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const anchor = new THREE.Vector3();
  const box = new THREE.Box3();
  const color = new THREE.Color();
  let active = false;
  let cooldown = 0;

  const burst = (count: number) => {
    context.anchor(anchor);
    if (context.object()) { context.bounds(box); anchor.y = box.max.y; }
    const palette = PALETTES[str(params, "palette", "party")] ?? PALETTES.party;
    const spread = num(params, "spread", 1);
    let made = 0;
    for (let index = 0; index < capacity && made < count; index += 1) {
      const piece = pieces[index];
      if (piece.alive) continue;
      piece.alive = true;
      piece.life = 0;
      piece.position.copy(anchor);
      const angle = Math.random() * Math.PI * 2;
      const lift = 2.2 + Math.random() * 2.2;
      piece.velocity.set(Math.cos(angle) * spread * (0.6 + Math.random() * 1.6), lift * Math.sqrt(spread), Math.sin(angle) * spread * (0.6 + Math.random() * 1.6));
      piece.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
      piece.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      mesh.setColorAt(index, color.set(palette[Math.floor(Math.random() * palette.length)]));
      made += 1;
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };

  return {
    update({ delta, time }) {
      cooldown = Math.max(0, cooldown - delta);
      if (active && str(params, "mode", "once") === "loop" && cooldown === 0) { burst(Math.round(num(params, "count", 160) / 3)); cooldown = 1.4; }
      let highest = 0;
      for (let index = 0; index < capacity; index += 1) {
        const piece = pieces[index];
        if (!piece.alive) { matrix.makeScale(0, 0, 0); mesh.setMatrixAt(index, matrix); continue; }
        piece.life += delta;
        piece.velocity.y -= 3.2 * delta;
        piece.velocity.multiplyScalar(1 - Math.min(1, delta * 1.6));
        piece.velocity.x += Math.sin(time * 3 + index) * delta * 0.6;
        piece.position.addScaledVector(piece.velocity, delta);
        piece.rotation.x += piece.spin.x * delta;
        piece.rotation.y += piece.spin.y * delta;
        piece.rotation.z += piece.spin.z * delta;
        const fade = piece.life > 3.4 ? Math.max(0, 1 - (piece.life - 3.4) / 0.6) : 1;
        if (fade <= 0) { piece.alive = false; matrix.makeScale(0, 0, 0); mesh.setMatrixAt(index, matrix); continue; }
        quaternion.setFromEuler(piece.rotation);
        scale.setScalar(fade);
        matrix.compose(piece.position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
        highest = index + 1;
      }
      mesh.count = highest;
      mesh.instanceMatrix.needsUpdate = true;
    },
    setActive(value) {
      if (value && !active) burst(Math.round(num(params, "count", 160)));
      active = value;
    },
    play() { burst(Math.round(num(params, "count", 160))); },
    setParams(next) { params = next; },
    dispose() { context.scene.remove(mesh); geometry.dispose(); material.dispose(); mesh.dispose(); }
  };
};

export default create;
