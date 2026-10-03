import * as THREE from "three";
import type { ShapeFactory } from "@/lib/experience/registry";
import type { PlacedObject } from "@/lib/experience/types";

function colorOf(object: PlacedObject, fallback: string) {
  return object.source.kind === "shape" && object.source.color ? object.source.color : fallback;
}

/** A map pin standing on its point, so the pin's tip sits on the placement. */
export const marker: ShapeFactory = (object) => {
  const group = new THREE.Group();
  const color = new THREE.Color(colorOf(object, "#e03c31"));
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 32, 20), material);
  head.position.y = 0.33;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.24, 32, 1, true).rotateX(Math.PI), material);
  tip.position.y = 0.2;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 12), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }));
  dot.position.set(0, 0.36, 0.1);
  group.add(head, tip, dot);
  return group;
};

/** A glowing sphere with a soft additive halo. */
export const orb: ShapeFactory = (object) => {
  const group = new THREE.Group();
  const color = new THREE.Color(colorOf(object, "#7fd6ff"));
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 40, 24),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6, roughness: 0.2 })
  );
  core.position.y = 0.15;
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.85
  }));
  halo.scale.setScalar(0.7);
  halo.position.y = 0.15;
  halo.raycast = () => {};
  group.add(core, halo);
  return group;
};

export const box: ShapeFactory = (object) => {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.4, 0.4).translate(0, 0.2, 0),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(colorOf(object, "#d9cbb3")), roughness: 0.8 })
  );
  return mesh;
};

/** A card that shows the object's text on both faces. */
export const sign: ShapeFactory = (object) => {
  const text = object.source.kind === "shape" ? object.source.text || object.name : object.name;
  const background = colorOf(object, "#ffffff");
  const canvas = document.createElement("canvas");
  const width = 1024;
  const context = canvas.getContext("2d")!;
  const font = "500 64px Helvetica, Arial, sans-serif";
  context.font = font;
  const lines = wrap(context, text, width - 128).slice(0, 6);
  const height = Math.max(192, 96 + lines.length * 84);
  canvas.width = width;
  canvas.height = height;
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#111111";
  context.fillRect(0, 0, width, 10);
  const ink = new THREE.Color(background).getHSL({ h: 0, s: 0, l: 0 }).l > 0.5 ? "#111111" : "#ffffff";
  context.fillStyle = ink;
  context.font = font;
  context.textBaseline = "top";
  lines.forEach((line, index) => context.fillText(line, 64, 56 + index * 84));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const aspect = height / width;
  const card = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 0.8 * aspect).translate(0, 0.8 * aspect / 2 + 0.05, 0),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false })
  );
  return card;
};

function wrap(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (context.measureText(next).width > maxWidth && line) { lines.push(line); line = word; }
      else line = next;
    }
    lines.push(line);
  }
  return lines;
}

let sharedHalo: THREE.Texture | null = null;
export function haloTexture() {
  if (sharedHalo) return sharedHalo;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,.45)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  sharedHalo = new THREE.CanvasTexture(canvas);
  return sharedHalo;
}
