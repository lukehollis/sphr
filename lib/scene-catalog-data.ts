import type { SceneListing } from "./scene-types";

export function parseSceneCatalog(content: string, assetBase = ""): SceneListing[] {
  const catalog = JSON.parse(content);
  if (!Array.isArray(catalog.spaces)) throw new Error("Invalid scene catalog: expected spaces array.");
  const ids = new Set<string>();
  const aliases = new Set<string>();
  return catalog.spaces.map((entry: SceneListing) => {
    if (!entry || !/^[a-f0-9]{12}$/.test(entry.sceneId) || ids.has(entry.sceneId)
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.titleSlug)
      || entry.scenePath !== `/s/${entry.sceneId}/${entry.titleSlug}`
      || typeof entry.title !== "string" || !entry.title.trim()) throw new Error("Invalid scene catalog entry.");
    function asset(value: string, type: "config" | "thumbnail") {
      if (typeof value !== "string") throw new Error("Missing scene asset URL.");
      const end = type === "config" ? "bootstrap\\.json" : "(?:preview\\.jpg|faces/scan-\\d+/face\\d\\.jpg)";
      const local = new RegExp(`^/datasets/(?:matterport|legacy)/[a-z0-9-]+/${end}$`);
      if (local.test(value)) return assetBase ? assetBase.replace(/\/$/, "") + value : value;
      if (assetBase) {
        const base = new URL(assetBase.replace(/\/$/, "") + "/");
        const url = new URL(value);
        const relative = url.pathname.slice(base.pathname.length);
        const published = new RegExp(`^scenes/${entry.sceneId}/[a-f0-9]{16}/${end}$`);
        if (/^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash
          && url.origin === base.origin && url.pathname.startsWith(base.pathname) && published.test(relative)) return url.href;
      }
      throw new Error(`Invalid scene ${type} URL: ${value}`);
    }
    ids.add(entry.sceneId);
    if (entry.hasGuidedTour !== undefined && typeof entry.hasGuidedTour !== 'boolean') {
      throw new Error('Invalid guided tour availability.');
    }
    if (entry.legacy && (!['space', 'tour'].includes(entry.legacy.kind) || !/^[1-9][0-9]*$/.test(entry.legacy.id))) {
      throw new Error('Invalid legacy scene identity.');
    }
    if (entry.legacy) {
      const alias = `${entry.legacy.kind}:${entry.legacy.id}`;
      if (aliases.has(alias)) throw new Error('Duplicate legacy scene identity.');
      aliases.add(alias);
    }
    return {
      sceneId: entry.sceneId, titleSlug: entry.titleSlug, scenePath: entry.scenePath,
      slug: entry.slug, title: entry.title, bootstrapUrl: asset(entry.bootstrapUrl, "config"),
      thumbnail: asset(entry.thumbnail, "thumbnail"), nodeCount: Number(entry.nodeCount) || 0,
      createdAt: entry.createdAt || "", ...(entry.legacy ? { legacy: entry.legacy } : {}),
      ...(entry.sourceType ? { sourceType: entry.sourceType } : {}),
      ...(entry.hasGuidedTour !== undefined ? { hasGuidedTour: entry.hasGuidedTour } : {})
    };
  });
}
