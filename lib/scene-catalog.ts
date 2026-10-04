import { readFile } from "node:fs/promises";
import path from "node:path";
import { cache } from "react";
import type { SceneListing } from "@/lib/scene-types";
import { parseSceneCatalog } from "./scene-catalog-data";
import { isScenePublic, readSceneEdits, readSceneTourTitles } from "./server/admin-store";
import { editedListing, tourNamedListing } from "./scene-edits";
import { isAdmin } from "./server/auth";
import { accountsEnabled, sceneAccess } from "./server/accounts";
import { readCustomerListings } from "./server/accounts-store";
import { customerAssetBase } from "./server/worker";

// Request-scoped caching: imports become visible without rebuilding the application.
export const readSourceScenes = cache(async (): Promise<SceneListing[]> => {
  const assetBase = process.env.SPHR_ASSET_BASE_URL || "";
  const catalogUrl = process.env.SPHR_CATALOG_URL;
  if (catalogUrl) {
    const response = await fetch(catalogUrl, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Scene catalog unavailable: HTTP ${response.status}`);
    return withCustomerScenes(parseSceneCatalog(await response.text(), assetBase));
  }
  const catalogs = await Promise.all(['matterport', 'legacy'].map(async (root) => {
    try {
      return parseSceneCatalog(await readFile(path.join(process.cwd(), `public/datasets/${root}/index.json`), 'utf8'), assetBase);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }));
  const scenes = catalogs.flat();
  if (new Set(scenes.map(scene => scene.sceneId)).size !== scenes.length) throw new Error('Duplicate scene identity across catalogs.');
  return withCustomerScenes(scenes);
});

/** Hosted customer spaces are listed from the application database, never the public catalog. */
function withCustomerScenes(scenes: SceneListing[]) {
  if (!accountsEnabled()) return scenes;
  const ids = new Set(scenes.map(scene => scene.sceneId));
  const customer = readCustomerListings().flatMap(listing => {
    try { return parseSceneCatalog(JSON.stringify({ spaces: [listing] }), customerAssetBase()); }
    catch (error) { console.error('Skipping an invalid customer listing:', error instanceof Error ? error.message : error); return []; }
  }).filter(scene => !ids.has(scene.sceneId));
  return [...scenes, ...customer];
}

export const readAllScenes = cache(async (): Promise<SceneListing[]> => {
  const edits = readSceneEdits();
  const tours = readSceneTourTitles();
  return (await readSourceScenes()).map(scene => tourNamedListing(editedListing(scene, edits.get(scene.sceneId)), tours.get(scene.sceneId)));
});

export const readSceneCatalog = cache(async (): Promise<SceneListing[]> => {
  const scenes = await readAllScenes();
  if (await isAdmin()) return scenes;
  const allowed = await Promise.all(scenes.map(async scene => isScenePublic(scene.sceneId) && await sceneAccess(scene.sceneId) === "allowed"));
  return scenes.filter((_scene, index) => allowed[index]);
});

export async function findScene(id: string) {
  if (!/^[a-f0-9]{12}$/.test(id)) return undefined;
  if (await sceneAccess(id) !== "allowed") return undefined;
  return (await readAllScenes()).find(scene => scene.sceneId === id);
}
