import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The browser key for Google's photorealistic 3D map, for tour stops seen from
 * above. Google's tiles are fetched from the visitor's browser, so this key is
 * public by nature: restrict it to this site's addresses and the Map Tiles API
 * in the Google Cloud console.
 */
export async function GET() {
  const key = process.env.SPHR_GOOGLE_TILES_KEY?.trim();
  if (!key) return NextResponse.json({ error: "The 3D map is not set up on this site." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ key }, { headers: { "Cache-Control": "private, max-age=3600" } });
}
