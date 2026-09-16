import { readFile } from "node:fs/promises";
import path from "node:path";
import { cache } from "react";
import type { SceneListing } from "@/lib/scene-types";

// Request-scoped caching: imports become visible without rebuilding the application.
export const readSceneCatalog = cache(async (): Promise<SceneListing[]> => {
  let content: string;
  try {
    content = await readFile(path.join(process.cwd(), "public/datasets/matterport/index.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const catalog = JSON.parse(content);
  if (!Array.isArray(catalog.spaces)) throw new Error("Invalid scene catalog. Run npm run scenes:index.");
  const ids = new Set<string>();
  return catalog.spaces.map((entry: SceneListing) => {
    if (!/^[a-f0-9]{12}$/.test(entry.sceneId) || ids.has(entry.sceneId)
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.titleSlug)
      || entry.scenePath !== `/s/${entry.sceneId}/${entry.titleSlug}`
      || typeof entry.title !== "string" || !entry.title.trim()
      || !/^\/datasets\/matterport\/[a-z0-9-]+\/bootstrap\.json$/.test(entry.bootstrapUrl)
      || !/^\/datasets\/matterport\/[a-z0-9-]+\/(preview\.jpg|faces\/scan-\d+\/face\d\.jpg)$/.test(entry.thumbnail)) {
      throw new Error("Invalid scene catalog entry. Run npm run scenes:index.");
    }
    ids.add(entry.sceneId);
    return {
      sceneId: entry.sceneId, titleSlug: entry.titleSlug, scenePath: entry.scenePath,
      slug: entry.slug, title: entry.title, bootstrapUrl: entry.bootstrapUrl,
      thumbnail: entry.thumbnail, nodeCount: Number(entry.nodeCount) || 0,
      createdAt: entry.createdAt || ""
    };
  });
});

export async function findScene(id: string) {
  if (!/^[a-f0-9]{12}$/.test(id)) return undefined;
  return (await readSceneCatalog()).find(scene => scene.sceneId === id);
}
