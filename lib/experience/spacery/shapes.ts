import * as THREE from "three";
import type { ShapeFactory } from "@/lib/experience/registry";
import type { PlacedObject } from "@/lib/experience/types";

/** Collectibles and props for tours and hunts, built from geometry so they load instantly. */

const tint = (object: PlacedObject, fallback: string) => new THREE.Color(object.source.kind === "shape" && object.source.color ? object.source.color : fallback);
const metal = (color: THREE.Color, roughness = 0.28) => new THREE.MeshStandardMaterial({ color, metalness: 0.85, roughness, emissive: color.clone().multiplyScalar(0.08) });
const matte = (color: THREE.Color | number, roughness = 0.7) => new THREE.MeshStandardMaterial({ color, roughness });

function starShape(outer: number, inner: number, points = 5) {
  const shape = new THREE.Shape();
  for (let index = 0; index <= points * 2; index += 1) {
    const radius = index % 2 ? inner : outer;
    const angle = index / (points * 2) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
    if (index === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  return shape;
}

export const gem: ShapeFactory = (object) => {
  const color = tint(object, "#38d1ff");
  const geometry = new THREE.OctahedronGeometry(0.11, 0).scale(1, 1.35, 1).translate(0, 0.16, 0);
  const material = new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.08, emissive: color.clone().multiplyScalar(0.35), flatShading: true, transparent: true, opacity: 0.92 });
  return new THREE.Mesh(geometry, material);
};

export const coin: ShapeFactory = (object) => {
  const color = tint(object, "#f4c542");
  const group = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.018, 40).rotateX(Math.PI / 2), metal(color));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.008, 8, 40), metal(color, 0.2));
  const star = new THREE.Mesh(new THREE.ExtrudeGeometry(starShape(0.05, 0.022), { depth: 0.006, bevelEnabled: false }).translate(0, 0, 0.009), metal(color.clone().multiplyScalar(1.1), 0.18));
  const back = star.clone();
  back.rotation.y = Math.PI;
  group.add(disc, rim, star, back);
  group.position.y = 0.1;
  const holder = new THREE.Group();
  holder.add(group);
  return holder;
};

export const star: ShapeFactory = (object) => {
  const color = tint(object, "#ffd23f");
  const geometry = new THREE.ExtrudeGeometry(starShape(0.15, 0.065), { depth: 0.04, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.012, bevelSegments: 2 }).center().translate(0, 0.17, 0);
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.25, emissive: color.clone().multiplyScalar(0.3) }));
};

export const key: ShapeFactory = (object) => {
  const color = tint(object, "#c9a227");
  const material = metal(color, 0.35);
  const group = new THREE.Group();
  const bow = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.012, 10, 28), material);
  bow.position.set(0, 0.2, 0);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.16, 12), material);
  shaft.position.set(0, 0.085, 0);
  const bit1 = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.016, 0.01), material);
  bit1.position.set(0.02, 0.02, 0);
  const bit2 = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.014, 0.01), material);
  bit2.position.set(0.015, 0.045, 0);
  group.add(bow, shaft, bit1, bit2);
  return group;
};

export const chest: ShapeFactory = (object) => {
  const wood = matte(tint(object, "#7a4a24"), 0.8);
  const trim = metal(new THREE.Color("#d4a94a"), 0.4);
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.26, 0.32).translate(0, 0.13, 0), wood);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.5, 24, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateX(Math.PI / 2), wood);
  lid.position.y = 0.26;
  lid.rotation.x = -Math.PI / 2;
  group.add(body, lid);
  for (const x of [-0.18, 0.18]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.27, 0.33).translate(0, 0.135, 0), trim);
    band.position.x = x;
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.163, 0.012, 6, 24, Math.PI).rotateY(Math.PI / 2), trim);
    arc.position.set(x, 0.26, 0);
    group.add(band, arc);
  }
  const lock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.02), trim);
  lock.position.set(0, 0.25, 0.17);
  group.add(lock);
  return group;
};

export const trophy: ShapeFactory = (object) => {
  const material = metal(tint(object, "#f4c542"), 0.22);
  const group = new THREE.Group();
  const cup = new THREE.Mesh(new THREE.LatheGeometry([0, 0.06, 0.08, 0.1, 0.11].map((radius, index) => new THREE.Vector2(radius, 0.18 + index * 0.035)), 32), material);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, 0.1, 16).translate(0, 0.12, 0), material);
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.12).translate(0, 0.045, 0), matte(0x2b2b2b, 0.5));
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.03, 20).translate(0, 0.085, 0), material);
  group.add(cup, stem, base, plinth);
  for (const side of [-1, 1]) {
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 8, 20, Math.PI), material);
    handle.rotation.z = side * Math.PI / 2;
    handle.position.set(side * 0.105, 0.26, 0);
    group.add(handle);
  }
  return group;
};

export const lantern: ShapeFactory = (object) => {
  const glow = tint(object, "#ffcf7a");
  const frame = matte(0x1c1c1c, 0.5);
  const group = new THREE.Group();
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.12).translate(0, 0.12, 0), new THREE.MeshStandardMaterial({ color: glow, emissive: glow, emissiveIntensity: 1.6, transparent: true, opacity: 0.85 }));
  const top = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.06, 4).rotateY(Math.PI / 4).translate(0, 0.23, 0), frame);
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.14).translate(0, 0.025, 0), frame);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.006, 8, 20), frame);
  ring.position.y = 0.275;
  group.add(glass, top, bottom, ring);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.17, 0.012).translate(0, 0.12, 0), frame);
    post.position.set(x * 0.062, 0, z * 0.062);
    group.add(post);
  }
  return group;
};

export const arrow: ShapeFactory = (object) => {
  const shape = new THREE.Shape();
  shape.moveTo(-0.04, 0); shape.lineTo(0.04, 0); shape.lineTo(0.04, 0.2); shape.lineTo(0.1, 0.2);
  shape.lineTo(0, 0.32); shape.lineTo(-0.1, 0.2); shape.lineTo(-0.04, 0.2); shape.lineTo(-0.04, 0);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 1 }).translate(0, 0, -0.015);
  const color = tint(object, "#e03c31");
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.45, emissive: color.clone().multiplyScalar(0.15) }));
};

export const question: ShapeFactory = (object) => {
  const color = tint(object, "#8b5cf6");
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.35, emissive: color.clone().multiplyScalar(0.25) });
  const group = new THREE.Group();
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.022, 12, 32, Math.PI * 1.35), material);
  hook.rotation.z = -Math.PI * 0.35;
  hook.position.y = 0.27;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.07, 14), material);
  neck.position.set(0, 0.15, 0);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12), material);
  dot.position.y = 0.06;
  group.add(hook, neck, dot);
  return group;
};

export const heart: ShapeFactory = (object) => {
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.08);
  shape.bezierCurveTo(-0.02, -0.06, -0.12, -0.02, -0.12, 0.04);
  shape.bezierCurveTo(-0.12, 0.1, -0.05, 0.12, 0, 0.07);
  shape.bezierCurveTo(0.05, 0.12, 0.12, 0.1, 0.12, 0.04);
  shape.bezierCurveTo(0.12, -0.02, 0.02, -0.06, 0, -0.08);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.015, bevelSegments: 4 }).center().translate(0, 0.14, 0);
  const color = tint(object, "#ff4f6d");
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.3, emissive: color.clone().multiplyScalar(0.2) }));
};

export const crystal: ShapeFactory = (object) => {
  const color = tint(object, "#7ef9ff");
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.1, metalness: 0.1, emissive: color.clone().multiplyScalar(0.45), flatShading: true, transparent: true, opacity: 0.88 });
  const group = new THREE.Group();
  const shards = [[0, 0, 0.24, 0], [0.05, 0.03, 0.16, 0.35], [-0.05, 0.02, 0.18, -0.3], [0.02, -0.05, 0.12, 0.2], [-0.03, -0.04, 0.14, -0.4]];
  for (const [x, z, height, lean] of shards) {
    const shard = new THREE.Mesh(new THREE.CylinderGeometry(0, 0.025, 0.05, 6).translate(0, height / 2 + 0.025, 0), material);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.028, height, 6).translate(0, height / 2, 0), material);
    const piece = new THREE.Group();
    shard.position.y = height / 2;
    piece.add(body, shard);
    piece.position.set(x, 0, z);
    piece.rotation.set(lean * 0.6, 0, lean);
    group.add(piece);
  }
  return group;
};

export const flower: ShapeFactory = (object) => {
  const color = tint(object, "#ff6b9a");
  const group = new THREE.Group();
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.01, 0.26, 8).translate(0, 0.13, 0), matte(0x4f8a3a));
  const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8).scale(1, 0.2, 0.45), matte(0x5aa344));
  leaf.position.set(0.035, 0.09, 0);
  leaf.rotation.z = 0.5;
  group.add(stem, leaf);
  const petal = new THREE.SphereGeometry(0.045, 14, 10).scale(1, 0.3, 0.55);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
  for (let index = 0; index < 6; index += 1) {
    const mesh = new THREE.Mesh(petal, material);
    const angle = index / 6 * Math.PI * 2;
    mesh.position.set(Math.cos(angle) * 0.045, 0.27, Math.sin(angle) * 0.045);
    mesh.rotation.y = -angle;
    mesh.rotation.z = 0.25;
    group.add(mesh);
  }
  const center = new THREE.Mesh(new THREE.SphereGeometry(0.025, 14, 10), new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.4 }));
  center.position.y = 0.275;
  group.add(center);
  return group;
};

export const balloon: ShapeFactory = (object) => {
  const color = tint(object, "#ff4f6d");
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.13, 32, 24).scale(1, 1.18, 1), new THREE.MeshStandardMaterial({ color, roughness: 0.25, metalness: 0.05 }));
  body.position.y = 0.62;
  const knot = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.03, 10).rotateX(Math.PI), body.material);
  knot.position.y = 0.46;
  const string = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 12 }, (_, index) => new THREE.Vector3(Math.sin(index * 0.8) * 0.012, 0.45 - index * 0.04, 0))), new THREE.LineBasicMaterial({ color: 0xeeeeee }));
  group.add(body, knot, string);
  return group;
};
