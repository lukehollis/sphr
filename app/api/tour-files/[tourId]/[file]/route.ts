import { readFile } from "node:fs/promises";
import { tourModelFile } from "@/lib/server/user-tours";

/** A model a customer added to a tour. Names are content hashes, so files never change. */
export async function GET(_request: Request, { params }: { params: Promise<{ tourId: string; file: string }> }) {
  const { tourId, file } = await params;
  const found = tourModelFile(tourId, file);
  if (!found) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(await readFile(found)), { headers: {
    "Content-Type": "model/gltf-binary", "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"
  } });
}
