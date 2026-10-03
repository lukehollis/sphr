import type { LibraryModel } from "@/lib/experience/library";

/** Words that carry no meaning in a search for models. */
const STOPWORDS = new Set("the and for with that this make tour hunt space around into from each stop stops find things about some have will they them their where what when then than like want please also very more most just model models".split(" "));

export function searchWords(text: string) {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !STOPWORDS.has(word)).map((word) => word.replace(/(ies|es|s)$/, "")))];
}

/**
 * Models that best match a request: names count most, then tags and category,
 * then pack, and models that match every word rank first. An exact model ID
 * always comes first.
 */
export function searchLibrary(models: LibraryModel[], query: string, limit = 24): LibraryModel[] {
  const exact = models.find((model) => model.id === query.trim());
  const words = searchWords(query);
  if (!words.length) return exact ? [exact] : [];
  const scored = models.map((model, index) => {
    const name = model.name.toLowerCase();
    const labels = `${model.category} ${(model.tags ?? []).join(" ")}`.toLowerCase();
    const pack = (model.pack ?? "").toLowerCase();
    let score = 0;
    let matched = 0;
    for (const word of words) {
      const points = name.includes(word) ? 3 : labels.includes(word) ? 2 : pack.includes(word) ? 1 : 0;
      score += points;
      if (points) matched += 1;
    }
    if (matched === words.length) score += 2;
    return { model, index, score };
  });
  const found = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.model);
  return (exact ? [exact, ...found.filter((model) => model !== exact)] : found).slice(0, Math.max(1, Math.min(60, limit)));
}

/** The animation clips a model plays (characters and animals), when the library lists them. */
export function modelAnimations(model: LibraryModel) {
  const clips = (model as LibraryModel & { animations?: unknown }).animations;
  return Array.isArray(clips) ? clips.filter((clip): clip is string => typeof clip === "string") : [];
}

/** One line per model for agents: its ID (used as the model's url), name, kind, size and animations. */
export function describeModel(model: LibraryModel) {
  const clips = modelAnimations(model);
  return `${model.id}: ${model.name} (${model.category}${model.pack ? `, ${model.pack}` : ""}), about ${Math.round(model.height * 100) / 100} m tall at scale 1${model.tags?.length ? `, ${model.tags.join(" ")}` : ""}${clips.length ? `, animated: ${clips.join(", ")}` : ""}`;
}
