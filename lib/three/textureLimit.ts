import type * as THREE from "three";

/**
 * The longest side a model's texture keeps once drawn. Some capture meshes come with 8192-pixel
 * maps, about 340 MB of graphics memory each with mipmaps, for a mesh the panorama hides: enough
 * on its own for Safari on some Macs to drop the WebGL context (the Tomb of Ramesses V and VI).
 * Phones keep to the size of their light copies.
 */
export const modelTextureLimit = (light: boolean) => (light ? 2048 : 4096);

type Pixels = CanvasImageSource & { width: number; height: number };

const isBitmap = (image: unknown): image is ImageBitmap => typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap;

/** Images a 2D canvas can draw: what GLTFLoader decodes (a bitmap, or an image element in older Safari). */
function drawable(image: unknown): image is Pixels {
  return isBitmap(image)
    || (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement)
    || (typeof HTMLCanvasElement !== "undefined" && image instanceof HTMLCanvasElement);
}

const texturesOf = (material: THREE.Material) =>
  Object.values(material).filter((value): value is THREE.Texture => Boolean((value as THREE.Texture | null)?.isTexture));

/** Every texture the meshes under this object draw with. */
export function modelTextures(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  root.traverse((child) => {
    const material = (child as THREE.Mesh).material;
    if (!material) return;
    for (const item of Array.isArray(material) ? material : [material]) texturesOf(item).forEach((texture) => textures.add(texture));
  });
  return textures;
}

/** A smaller copy drawn through a canvas, which every browser can do (createImageBitmap's resize options are newer). */
async function shrink(image: Pixels, width: number, height: number): Promise<Pixels | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  if (typeof createImageBitmap !== "function") return canvas;
  try {
    const bitmap = await createImageBitmap(canvas);
    canvas.width = canvas.height = 0;
    return bitmap;
  } catch {
    return canvas;
  }
}

/**
 * Brings a loaded model's textures within `limit` pixels a side before it is first drawn, and lets
 * go of the images of `decoded` textures the model no longer draws with: an unlit capture mesh keeps
 * only its colour map, though its normal map was decoded too.
 */
export async function fitModelTextures(root: THREE.Object3D, limit: number, decoded: Iterable<THREE.Texture> = []) {
  const drawn = modelTextures(root);
  const kept = new Set([...drawn].map((texture) => texture.source));
  for (const texture of decoded) {
    if (kept.has(texture.source)) continue;
    if (isBitmap(texture.source.data)) texture.source.data.close();
    texture.dispose();
  }

  const bySource = new Map<THREE.Texture["source"], THREE.Texture[]>();
  for (const texture of drawn) bySource.set(texture.source, [...(bySource.get(texture.source) ?? []), texture]);
  await Promise.all([...bySource].map(async ([source, textures]) => {
    const image = source.data as unknown;
    if (!drawable(image)) return;
    const width = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
    const height = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
    if (Math.max(width, height) <= limit) return;
    const scale = limit / Math.max(width, height);
    const smaller = await shrink(image, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    if (!smaller) return;
    source.data = smaller;
    textures.forEach((texture) => { texture.needsUpdate = true; });
    if (isBitmap(image)) image.close();
  }));
}
