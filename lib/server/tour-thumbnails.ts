import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { db } from "./admin-store";

/**
 * A tour's own picture for cards and link previews: a frame of the tour at a telling stop, with
 * its effects, objects, look and sky, so it reads differently from the plain space. Keyed by a
 * customer's tour ID, or `scene-<scene ID>` for one of the site's own guided tours. Without one,
 * cards fall back to the space's thumbnail.
 */
let prepared = false;
const folder = () => path.join(process.env.SPHR_STATE_DIR ?? "", "tour-thumbs");
const validKey = (key: string) => /^([a-f0-9]{12}|scene-[a-f0-9]{12})$/.test(key);

function store() {
  const connection = db();
  if (prepared) return connection;
  connection.exec("CREATE TABLE IF NOT EXISTS tour_thumbnails (tour TEXT PRIMARY KEY, file TEXT NOT NULL, changed TEXT NOT NULL)");
  prepared = true;
  return connection;
}

/** The address of a tour's own thumbnail, if it has one. */
export function tourThumbnail(key: string): string | undefined {
  if (!process.env.SPHR_STATE_DIR || !validKey(key)) return undefined;
  const row = store().prepare("SELECT file FROM tour_thumbnails WHERE tour=?").get(key) as { file: string } | undefined;
  return row ? `/api/tour-thumbs/${row.file}` : undefined;
}

/** Keeps a new thumbnail for a tour: cropped to 3 by 2 and re-encoded, replacing the previous one. */
export async function saveTourThumbnail(key: string, bytes: Buffer) {
  if (!validKey(key)) throw new Error("Invalid tour.");
  let image: Buffer;
  try {
    image = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" }).rotate().resize(1200, 800, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
  } catch { throw new Error("Send the thumbnail as a JPEG, PNG or WebP image."); }
  const file = `${createHash("sha256").update(image).digest("hex").slice(0, 16)}.webp`;
  mkdirSync(folder(), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(folder(), file), image, { mode: 0o600 });
  const previous = (store().prepare("SELECT file FROM tour_thumbnails WHERE tour=?").get(key) as { file: string } | undefined)?.file;
  store().prepare("INSERT INTO tour_thumbnails(tour, file, changed) VALUES (?, ?, ?) ON CONFLICT(tour) DO UPDATE SET file=excluded.file, changed=excluded.changed")
    .run(key, file, new Date().toISOString());
  if (previous && previous !== file) rmSync(path.join(folder(), previous), { force: true });
  return `/api/tour-thumbs/${file}`;
}

export function tourThumbnailFile(name: string) {
  if (!/^[a-f0-9]{16}\.webp$/.test(name) || !process.env.SPHR_STATE_DIR) return null;
  const file = path.join(folder(), name);
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}
