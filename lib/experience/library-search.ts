import type { LibraryModel } from "@/lib/experience/library";

/** Words that carry no meaning in a search for models. */
const STOPWORDS = new Set("the and for with that this make tour hunt space around into from each stop stops find things about some have will they them their where what when then than like want please also very more most just model models".split(" "));

/** A word without its plural ending: statues to statue, boxes to box, berries to berry. */
export function stem(word: string) {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(sses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function searchWords(text: string) {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !STOPWORDS.has(word)).map(stem))];
}

const wordsOf = (text: string) => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem);

/**
 * How well a model matches search words: a word in its name counts most, then in its
 * category or tags, then in its pack. Whole words only (camel is not Camelot, owl is not
 * bowl), or with `prefix` the beginnings of words, for someone still typing.
 */
export function matchModel(model: LibraryModel, words: string[], prefix = false) {
  const fields = [wordsOf(model.name), wordsOf(`${model.category} ${(model.tags ?? []).join(" ")}`), wordsOf(model.pack ?? "")];
  const has = (field: string[], word: string) => field.some((token) => token === word || (prefix && token.startsWith(word)));
  let score = 0;
  let matched = 0;
  for (const word of words) {
    const points = has(fields[0], word) ? 3 : has(fields[1], word) ? 2 : has(fields[2], word) ? 1 : 0;
    score += points;
    if (points) matched += 1;
  }
  return { score: score + (words.length && matched === words.length ? 2 : 0), all: matched === words.length };
}

/**
 * Models that best match a request: names count most, then tags and category,
 * then pack, and models that match every word rank first. An exact model ID
 * always comes first. Whole words only: agents search with whole words, and a
 * word that only begins another (camel in Camelot) is a different thing.
 */
export function searchLibrary(models: LibraryModel[], query: string, limit = 24): LibraryModel[] {
  const exact = models.find((model) => model.id === query.trim());
  const words = searchWords(query);
  if (!words.length) return exact ? [exact] : [];
  const found = models.map((model, index) => ({ model, index, score: matchModel(model, words).score }))
    .filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.model);
  return (exact ? [exact, ...found.filter((model) => model !== exact)] : found).slice(0, Math.max(1, Math.min(60, limit)));
}

/** The animation clips a model plays (characters and animals), when the library lists them. */
export function modelAnimations(model: LibraryModel) {
  const clips: unknown = model.animations;
  return Array.isArray(clips) ? clips.filter((clip): clip is string => typeof clip === "string") : [];
}

/** One line per model for agents: its ID (used as the model's url), name, kind, size and animations. */
export function describeModel(model: LibraryModel) {
  const clips = modelAnimations(model);
  return `${model.id}: ${model.name} (${model.category}${model.pack ? `, ${model.pack}` : ""}), about ${Math.round(model.height * 100) / 100} m tall at scale 1${model.tags?.length ? `, ${model.tags.join(" ")}` : ""}${clips.length ? `, animated: ${clips.join(", ")}` : ""}`;
}
