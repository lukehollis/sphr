import sharp from "sharp";
import { readSceneThumbnail } from "./admin-store";

/**
 * A tiny copy of a space's picture for its loading screen, which shows it blurred and dimmed anyway.
 * Inline in the page it costs no request: the full picture (often 200 kB) used to share a slow phone
 * connection with the viewer's code and the first view. Copies are remembered; while one is being
 * made, or when it cannot be, the page gets the full picture as before.
 */
const made = new Map<string, { at: number; data: string | null }>();
const making = new Map<string, Promise<string | null>>();

/** A picture set in the admin (served by /api/scenes/<id>/thumbnail) is read where it is kept. */
const stored = /^\/api\/scenes\/([a-f0-9]{12})\/thumbnail(\?|$)/;

async function picture(url: string) {
  const scene = stored.exec(url)?.[1];
  if (scene) return readSceneThumbnail(scene);
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined;
}

async function make(url: string) {
  try {
    const bytes = await picture(url);
    if (!bytes) return null;
    const small = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" }).rotate()
      .resize(48, 48, { fit: "inside" }).jpeg({ quality: 60 }).toBuffer();
    return `data:image/jpeg;base64,${small.toString("base64")}`;
  } catch {
    return null;
  }
}

/** The inline copy when it is ready within `waitMs`, else the picture's own address. */
export async function loadingPlaceholder(url: string, waitMs = 400) {
  if (!/^https:\/\/[^\s]+$/.test(url) && !stored.test(url)) return url;
  const known = made.get(url);
  // A picture that could not be copied is tried again after ten minutes.
  if (known && (known.data || Date.now() - known.at < 10 * 60 * 1000)) return known.data ?? url;
  let pending = making.get(url);
  if (!pending) {
    pending = make(url).then((data) => {
      made.set(url, { at: Date.now(), data });
      if (made.size > 2000) made.delete(made.keys().next().value!);
      return data;
    }).finally(() => making.delete(url));
    making.set(url, pending);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const data = await Promise.race([pending, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); })]);
  clearTimeout(timer);
  return data ?? url;
}
