/**
 * A model library is a JSON manifest of ready-to-place glTF models:
 * { "models": [{ "id", "name", "category", "url", "height", "tags", "thumbnail", "pack", "credit", "animations", "scope" }] }.
 * "team" models are offered only to administrators, for assets whose license
 * does not allow handing them to every customer.
 */
export type LibraryModel = {
  id: string;
  name: string;
  category: string;
  url: string;
  /** Height in meters at scale 1. */
  height: number;
  tags?: string[];
  thumbnail?: string;
  pack?: string;
  /** Who made the model, for the builder's tooltip. */
  credit?: string;
  /** Names of the animation clips an animated model carries. */
  animations?: string[];
  scope?: "everyone" | "team";
};

export function parseLibrary(value: unknown, base = ""): LibraryModel[] {
  const models = (value as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const resolve = (url: string) => /^https:\/\//.test(url) || url.startsWith("/") ? url : base ? `${base.replace(/\/$/, "")}/${url.replace(/^\.?\//, "")}` : url;
  return models.flatMap((item) => {
    const model = item as Record<string, unknown>;
    if (typeof model?.id !== "string" || typeof model.url !== "string" || typeof model.name !== "string") return [];
    const url = resolve(model.url);
    if (!/^https:\/\//.test(url) && !url.startsWith("/")) return [];
    return [{
      id: model.id.slice(0, 120),
      name: model.name.slice(0, 120),
      category: typeof model.category === "string" ? model.category.slice(0, 60) : "Models",
      url,
      height: typeof model.height === "number" && Number.isFinite(model.height) ? model.height : 1,
      ...(Array.isArray(model.tags) ? { tags: model.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 12) } : {}),
      ...(typeof model.thumbnail === "string" ? { thumbnail: resolve(model.thumbnail) } : {}),
      ...(typeof model.pack === "string" ? { pack: model.pack.slice(0, 80) } : {}),
      ...(typeof model.credit === "string" ? { credit: model.credit.slice(0, 80) } : {}),
      ...(Array.isArray(model.animations) ? { animations: model.animations.filter((clip): clip is string => typeof clip === "string").slice(0, 24).map((clip) => clip.slice(0, 60)) } : {}),
      scope: model.scope === "team" ? "team" as const : "everyone" as const
    }];
  });
}
