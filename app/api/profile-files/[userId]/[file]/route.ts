import { readFile } from "node:fs/promises";
import { profileImageFile } from "@/lib/server/profiles";

/** A profile picture or cover. Names carry a content hash, so a file never changes. */
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string; file: string }> }) {
  const { userId, file } = await params;
  const found = profileImageFile(userId, file);
  if (!found) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(await readFile(found)), { headers: {
    "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"
  } });
}
