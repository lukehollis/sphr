import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { SphrBootstrap } from '../types';
import type { SceneListing } from '../scene-types';

// URL comes exclusively from the validated catalog, never from the request body.
export async function readSceneBootstrap(scene: SceneListing): Promise<SphrBootstrap> {
  if (scene.bootstrapUrl.startsWith('/datasets/')) {
    return JSON.parse(await readFile(path.join(process.cwd(), 'public', scene.bootstrapUrl), 'utf8'));
  }
  const response = await fetch(scene.bootstrapUrl, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('The scene configuration is unavailable. Try again.');
  return await response.json() as SphrBootstrap;
}

export async function decodeThumbnail(value: unknown): Promise<Buffer> {
  if (typeof value !== 'string' || value.length > 950000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Capture a JPEG thumbnail from the viewer.');
  }
  try {
    const bytes = Buffer.from(value.slice('data:image/jpeg;base64,'.length), 'base64');
    const image = sharp(bytes, { limitInputPixels: 1024 * 1024, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== 'jpeg' || metadata.width !== 960 || metadata.height !== 640) throw new Error('Invalid size');
    return await image.jpeg({ quality: 88 }).toBuffer();
  } catch { throw new Error('Invalid thumbnail. Capture the view again.'); }
}
