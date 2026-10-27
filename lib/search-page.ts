import { normalizeTour, tourContinue } from "@/lib/bootstrap";
import { applyExperience } from "@/lib/experience/apply";
import { paragraphs, type Experience, type ExperienceKind } from "@/lib/experience/types";
import type { MediaFile, SphrBootstrap, TourContinue, TourSpace } from "@/lib/types";

/**
 * What a search engine reads on a space, tour or hunt page: its title and description, and the
 * tour's stops as text, taken from the same scene file and edits the viewer shows.
 */

export type PageKind = "space" | ExperienceKind;
export type SearchStop = { title?: string; text: string[] };
export type SearchText = { guided: boolean; kind: ExperienceKind; stops: SearchStop[]; finale: string[]; links: TourContinue[];
  /** The opening space's own name in the scene file, before any title edit. */
  spaceTitle?: string; coordinates?: { lat: number; lon: number } };

const titleLimit = 60;
export const descriptionLimit = 155;

/** House style for titles and descriptions: no colons, semicolons or dashes between words. */
export function plainCopy(text: string) {
  return text.replace(/\s+/g, " ")
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[–—]\s*|\s+-\s+/g, ", ")
    .replace(/\s*;\s*/g, ", ")
    .replace(/:(?=\s)/g, ",")
    .replace(/\s+,/g, ",").replace(/,(?:\s*,)+/g, ",")
    .replace(/^[,\s]+|[,\s]+$/g, "");
}

/** Whole sentences up to `limit` characters (when they say enough), or the words that fit with an ellipsis. */
export function fitText(text: string, limit = descriptionLimit) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  let kept = "";
  for (const sentence of clean.match(/[^.!?]+(?:[.!?]+["”’)\]]*|$)\s*/g) ?? []) {
    if ((kept + sentence).trim().length > limit) break;
    kept += sentence;
  }
  if (kept.trim().length >= Math.min(50, limit / 2)) return kept.trim();
  const cut = clean.slice(0, limit - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit / 2)).replace(/[\s,.;:]+$/, "")}…`;
}

/** A space's name inside a sentence: "a hunt in the Byzantine Church, Petra". */
export function inSentence(place: string) {
  return place.replace(/^The (?=\p{Lu})/u, "the ");
}

const key = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A tour named after its space ("The Royal Tombs" in "The Royal Tombs, Petra, Jordan") says nothing more than the space's name. */
export function namedAfter(name: string, place: string) {
  return key(place).startsWith(key(name));
}

/**
 * A page's title, at most 60 characters. A space goes by its name; a tour or hunt by its own name and
 * the space it is in ("Save the Scrolls, a hunt in the Byzantine Church, Petra"), so it never reads as the
 * space's own page. The site's name follows when it fits, then the place loses its last parts, then goes.
 */
export function pageTitle({ name, place, kind, brand }: { name: string; place: string; kind: PageKind; brand: string }) {
  const title = plainCopy(name), space = plainCopy(place);
  const parts = space.split(", ");
  const forms = parts.map((_, index) => parts.slice(0, parts.length - index).join(", "));
  const cores = kind === "space" ? [title]
    : namedAfter(title, space) ? forms.map((form) => `${form}, ${kind === "hunt" ? "a scavenger hunt" : "a guided tour"}`)
      : [...forms.map((form) => `${title}, ${kind === "hunt" ? "a hunt in" : "a tour of"} ${inSentence(form)}`), title];
  const fitting = [`${cores[0]} · ${brand}`, ...cores].find((candidate) => candidate.length <= titleLimit);
  return fitting ?? fitText(cores.at(-1)!, titleLimit);
}

/** The line under a tour's or hunt's name on its page. */
export function kindLine(kind: PageKind, name: string, place: string, guided: boolean) {
  if (kind === "space") return guided ? "A guided tour" : undefined;
  const what = kind === "hunt" ? "A scavenger hunt" : "A guided tour";
  return namedAfter(name, place) ? what : `${what} ${kind === "hunt" ? "in" : "of"} ${inSentence(place)}`;
}

/** The page's description: the first words a visitor reads there, up to 155 characters in the house style. */
export function pageDescription(sources: string[][], fallback: string) {
  for (const source of sources) {
    let text = "";
    for (const part of source) {
      text = text ? `${text} ${part}` : part;
      // A stop that says little takes the next one's words too.
      if (text.length >= 80) break;
    }
    if (text) return fitText(plainCopy(text));
  }
  return fitText(plainCopy(fallback));
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };

function decode(code: string) {
  if (code[0] !== "#") return entities[code.toLowerCase()];
  const hex = code[1].toLowerCase() === "x", value = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
  return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : undefined;
}

/** The paragraphs a visitor reads in older tours' HTML, as plain text. */
export function htmlParagraphs(html?: string | null) {
  if (!html) return [];
  const text = html
    .replace(/<(script|style|template|noscript|textarea|title|svg|math|iframe|object|select|button)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|li|blockquote)\s*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => decode(code) ?? match);
  return paragraphs(text).map((part) => part.replace(/\s+/g, " "));
}

/**
 * The parts of a scene file its page's text comes from: titles, stop text and onward links. Kept
 * between requests instead of the whole file, which carries every panorama and model.
 */
export function searchSource(input: SphrBootstrap): SphrBootstrap {
  const data = input.tour?.tour_data;
  const linked = (objects?: TourSpace["objects"]) => objects?.filter((object) => object.link)
    .map((object) => ({ ...object, source: { kind: "shape" as const, shape: "" } }));
  const segment = (space: TourSpace): TourSpace => ({ id: space.id, title: space.title, objects: linked(space.objects),
    tourpoints: (space.tourpoints ?? []).map((point) => ({ id: point.id, title: point.title, format: point.format, text: point.text,
      secondaryText: point.secondaryText, targetType: point.targetType, nodeUUID: point.nodeUUID, mapUrl: point.mapUrl, find: point.find,
      files: (point.files ?? []).map((): MediaFile => ({})) })) });
  const geo = input.space?.space_data?.geo;
  return {
    space: { id: input.space?.id, title: input.space?.title, type: input.space?.type, space_data: geo ? { geo } : {} } as SphrBootstrap["space"],
    orderedSpaces: input.orderedSpaces?.map((space) => ({ id: space.id, title: space.title, space_data: {} }) as SphrBootstrap["space"]),
    tour: input.tour ? { id: input.tour.id, title: input.tour.title, description: input.tour.description, tour_data: data ? {
      mode: data.mode, kind: data.kind, finale: data.finale, continueTo: data.continueTo, place: data.place, objects: linked(data.objects),
      spaces: (data.spaces ?? data.tourmodels)?.map(segment)
    } : undefined } : null,
    ui: {}
  };
}

/** The tour's stops as the viewer shows them, with a page's own tour or hunt written in. */
export function searchText(source: SphrBootstrap, edits: { experience?: Experience | null; standalone?: boolean } = {}): SearchText {
  const data = edits.experience ? applyExperience(source, edits.experience, { standalone: edits.standalone }) : source;
  const tour = normalizeTour(data);
  const hunt = tour.kind === "hunt";
  const stops = !tour.hasGuidedTour ? [] : tour.spaces.flatMap((space, spaceIndex) => space.tourpoints.map((point, index) => {
    const plain = point.format === "plain";
    const read = (value?: string | null) => plain ? paragraphs(value).map((part) => part.replace(/\s+/g, " ")) : htmlParagraphs(value);
    // Older tours kept their opening words on a start screen; the viewer shows them at an empty first stop.
    const opening = !point.text && !point.secondaryText && !point.files?.length && !point.mapUrl && spaceIndex === 0 && index === 0
      ? data.tour?.description : undefined;
    // The viewer names a stop over plain text and over a hunt's clues.
    const title = plain || hunt ? point.title?.trim() || undefined : undefined;
    return { title, text: [...read(point.text || opening), ...read(point.secondaryText)] };
  })).filter((stop) => stop.title || stop.text.length);
  const objects = [...tour.objects, ...tour.spaces.flatMap((space) => space.objects ?? [])];
  const links = [tour.continueTo, ...objects.map((object) => object.link ? tourContinue({ url: object.link, label: object.label || object.name }) : undefined)]
    .filter((link): link is TourContinue => Boolean(link))
    .filter((link, index, all) => all.findIndex((other) => other.url === link.url) === index);
  const place = tour.place;
  return { guided: tour.hasGuidedTour, kind: tour.kind, stops, finale: tour.hasGuidedTour ? paragraphs(tour.finale) : [], links,
    spaceTitle: data.space?.title?.trim() || undefined,
    ...(place && Number.isFinite(place.lat) && Number.isFinite(place.lon) ? { coordinates: { lat: place.lat, lon: place.lon } } : {}) };
}

export type PageData = {
  url: string; name: string; description: string; image?: string; place: string; location?: string;
  coordinates?: { lat: number; lon: number }; created?: string; updated?: string;
  author?: { name: string; url: string }; publisher: { id?: string; name: string; url: string };
};

/** Structured data for the page: a web page about a place, published by the site's operator. */
export function pageJsonLd(page: PageData) {
  const data = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${page.url}#page`,
    url: page.url,
    name: page.name,
    description: page.description,
    inLanguage: "en",
    ...(page.image ? { primaryImageOfPage: { "@type": "ImageObject", url: page.image }, image: page.image } : {}),
    ...(page.created ? { datePublished: page.created } : {}),
    ...(page.updated ? { dateModified: page.updated } : {}),
    about: {
      "@type": "Place",
      name: page.place,
      ...(page.location ? { address: page.location } : {}),
      ...(page.coordinates ? { geo: { "@type": "GeoCoordinates", latitude: page.coordinates.lat, longitude: page.coordinates.lon } } : {})
    },
    ...(page.author ? { author: { "@type": "Person", name: page.author.name, url: page.author.url } } : {}),
    publisher: { "@type": "Organization", ...(page.publisher.id ? { "@id": page.publisher.id } : {}), name: page.publisher.name, url: page.publisher.url }
  };
  // Inside a script element, "<" could close it early.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
