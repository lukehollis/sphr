function mapStrings<T>(value: T, rewrite: (text: string) => string): T {
  function visit(item: unknown): unknown {
    if (typeof item === "string") return rewrite(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  }
  return visit(value) as T;
}

/** Keep local imports portable; rewrite only the runtime's known public asset roots. */
export function withAssetBase<T>(value: T, base = process.env.NEXT_PUBLIC_SPHR_ASSET_BASE_URL || ""): T {
  if (!base) return value;
  const root = base.replace(/\/$/, "");
  return mapStrings(value, (item) => /^\/(datasets\/(?:matterport|legacy)|demo)\//.test(item) ? root + item : item);
}

// A file in one of the folders a downloaded space keeps beside its scene file (lib/server/space-export.ts),
// with the characters its paths may hold and a file extension, so text such as a tag's title never matches.
const folderFile = /^(?:faces|pano|mesh|splat|model|tour-files)(?:\/[\p{L}\p{N}._~()+,@=-]+)+$/u;

/** Make a downloaded space's folder-relative file paths addresses beside its scene file, wherever that is served. */
export function withConfigBase<T>(value: T, configUrl: string): T {
  return mapStrings(value, (item) => item === "preview.jpg" || (folderFile.test(item) && /\.[a-z0-9]+$/i.test(item))
    ? new URL(item, configUrl).href : item);
}
