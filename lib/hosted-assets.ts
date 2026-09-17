/** Keep local imports portable; rewrite only the runtime's known public asset roots. */
export function withAssetBase<T>(value: T, base = process.env.NEXT_PUBLIC_SPHR_ASSET_BASE_URL || ""): T {
  if (!base) return value;
  const root = base.replace(/\/$/, "");
  function visit(item: unknown): unknown {
    if (typeof item === "string") return /^\/(datasets\/(?:matterport|legacy)|demo)\//.test(item) ? root + item : item;
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  }
  return visit(value) as T;
}
