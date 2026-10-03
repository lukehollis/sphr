import { NextResponse } from "next/server";
import { modelAnimations, searchLibrary } from "@/lib/experience/library-search";
import { isAdmin } from "@/lib/server/auth";
import { libraryModels } from "@/lib/server/library";

/**
 * Search the model library that tours can place models from, for the builder's
 * agents and for people's own agents. Team-only models are found by administrators only.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").slice(0, 200);
  const limit = Number(url.searchParams.get("limit") ?? 24) || 24;
  const library = await libraryModels(await isAdmin());
  const models = searchLibrary(library, query, limit).map((model) => {
    const { id, name, category, pack, height, tags, thumbnail, url: modelUrl, credit } = model;
    const animations = modelAnimations(model);
    return { id, name, category, pack, height, tags, thumbnail, url: modelUrl, credit, ...(animations.length ? { animations } : {}) };
  });
  return NextResponse.json({ query, total: library.length, models }, { headers: { "Cache-Control": "private, max-age=60" } });
}
