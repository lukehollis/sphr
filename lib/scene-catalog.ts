import { readFile } from "node:fs/promises";
import path from "node:path";
import { cache } from "react";
import type { SceneListing } from "@/lib/scene-types";
import { parseSceneCatalog } from "./scene-catalog-data";
import { isScenePublic } from "./server/admin-store";
import { isAdmin } from "./server/auth";

// Request-scoped caching: imports become visible without rebuilding the application.
export const readAllScenes = cache(async (): Promise<SceneListing[]> => {
  const assetBase = process.env.SPHR_ASSET_BASE_URL || "";
  const catalogUrl = process.env.SPHR_CATALOG_URL;
  if (catalogUrl) {
    const response = await fetch(catalogUrl, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Scene catalog unavailable: HTTP ${response.status}`);
    return parseSceneCatalog(await response.text(), assetBase);
  }
  let content: string;
  try {
    content = await readFile(path.join(process.cwd(), "public/datasets/matterport/index.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseSceneCatalog(content, assetBase);
});

export const readSceneCatalog = cache(async (): Promise<SceneListing[]> => {
  const scenes = await readAllScenes();
  const admin = await isAdmin();
  return scenes.filter(scene => admin || isScenePublic(scene.sceneId));
});

export async function findScene(id: string) {
  if (!/^[a-f0-9]{12}$/.test(id)) return undefined;
  if (!isScenePublic(id) && !(await isAdmin())) return undefined;
  return (await readAllScenes()).find(scene => scene.sceneId === id);
}
