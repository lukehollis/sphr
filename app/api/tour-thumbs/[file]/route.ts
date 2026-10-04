import { readFile } from "node:fs/promises";
import { tourThumbnailFile } from "@/lib/server/tour-thumbnails";

/** A tour's thumbnail. Names carry a content hash, so a file never changes. */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const found = tourThumbnailFile((await params).file);
  if (!found) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(await readFile(found)), { headers: {
    "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"
  } });
}
