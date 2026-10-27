import { readFile } from "node:fs/promises";
import path from "node:path";
import { cache } from "react";
import type { Metadata, MetadataRoute } from "next";
import { readAllScenes } from "@/lib/scene-catalog";
import type { SceneListing } from "@/lib/scene-types";
import { emptyExperience, paragraphs, type Experience } from "@/lib/experience/types";
import { inSentence, kindLine, pageDescription, pageJsonLd, pageTitle, searchSource, searchText, type PageKind, type SearchText } from "@/lib/search-page";
import type { SphrBootstrap, TourContinue } from "@/lib/types";
import { accountsEnabled, openToEveryone } from "./accounts";
import { siteBrand, siteHome, siteOrigin } from "./brand";
import { profileCard, testTitle } from "./profiles";
import { readSpaceInfo } from "./space-info";
import { tourThumbnail } from "./tour-thumbnails";
import { readSceneTour } from "./tours";
import { canBuildOn, listSharedTours, readUserTour, tourPath, tourScene, type UserTour } from "./user-tours";

/**
 * Public space, tour and hunt pages as search engines read them. Only what anyone may open is
 * listed, and a private space's page carries none of its text.
 */

/** A space page search engines may list: open to everyone, and not a test. */
export function sceneSearchable(scene: SceneListing) {
  return openToEveryone(scene.sceneId) && !testTitle(scene.title);
}

/** A customer's tour or hunt search engines may list: shared, on a space they may list, and still open to its maker. */
export function tourSearchable(tour: UserTour, scene: SceneListing) {
  return accountsEnabled() && tour.public && sceneSearchable(scene) && canBuildOn(tour.userId, scene) && !testTitle(tour.title);
}

type Kept = { at: number; source: Promise<SphrBootstrap | null>; ok?: boolean };
const kept = new Map<string, Kept>();
const keepCount = 300, keepFor = 60 * 60 * 1000, retryAfter = 5 * 60 * 1000;

async function fetchSource(url: string) {
  // The address comes from the catalog, never from the request.
  if (url.startsWith("/datasets/")) return searchSource(JSON.parse(await readFile(path.join(process.cwd(), "public", url), "utf8")));
  const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return searchSource(await response.json() as SphrBootstrap);
}

/** The text parts of a scene file, kept for an hour; a file that could not be read is tried again after five minutes. */
function readSource(url: string) {
  const now = Date.now();
  const entry = kept.get(url);
  if (entry && now - entry.at < (entry.ok === false ? retryAfter : keepFor)) {
    kept.delete(url);
    kept.set(url, entry);
    return entry.source;
  }
  const fresh: Kept = { at: now, source: fetchSource(url).then((source) => { fresh.ok = true; return source; }, (error) => {
    fresh.ok = false;
    console.error(`No search text for ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }) };
  kept.set(url, fresh);
  for (const oldest of kept.keys()) {
    if (kept.size <= keepCount) break;
    kept.delete(oldest);
  }
  return fresh.source;
}

async function readText(scene: SceneListing, edits: { experience?: Experience | null; standalone?: boolean }): Promise<SearchText | null> {
  const source = await readSource(scene.bootstrapUrl);
  return source ? searchText(source, edits) : null;
}

export type SearchPage = {
  /** Open to everyone: listed, with its text on the page. */
  indexable: boolean;
  path: string;
  /** The tour's or space's own name, the page's heading. */
  name: string;
  line?: string;
  title: string;
  shareTitle: string;
  description: string;
  image: string;
  about: string[];
  text: SearchText | null;
  links: TourContinue[];
  author?: { name: string; path: string };
  host?: { name: string; href: string };
  jsonLd: string;
};

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** An older guided tour is listed under the tour's name ("Go Inside the Great Pyramid"); its scene file names the place itself. */
const guidedScene = (scene: SceneListing) => Boolean(scene.hasGuidedTour ?? scene.legacy?.kind === "tour");
const placeOf = (scene: SceneListing, text: SearchText | null) => guidedScene(scene) && text?.spaceTitle || scene.title;
const absolute = (url: string) => new URL(url, siteOrigin()).href;

function fallbackDescription(kind: PageKind, place: string) {
  if (kind === "hunt") return `A scavenger hunt in ${inSentence(place)} to play in your browser or a VR headset.`;
  if (kind === "tour") return `A guided tour of ${inSentence(place)} to take in your browser or a VR headset.`;
  return `${place}, in 3D. Look around and walk through it in your browser or a VR headset.`;
}

function searchPage({ indexable, path, name, place, placeName = place, kind, text, about, image, links, author, location, created, updated }: {
  indexable: boolean; path: string; name: string; place: string; placeName?: string; kind: PageKind; text: SearchText | null; about: string[]; image: string;
  links: TourContinue[]; author?: { name: string; path: string }; location?: string; created?: string; updated?: string;
}): SearchPage {
  const brand = siteBrand(), home = siteHome();
  const title = pageTitle({ name, place, kind, brand });
  const shareTitle = title.endsWith(` · ${brand}`) ? title.slice(0, -` · ${brand}`.length) : title;
  const spoken = text?.stops.flatMap((stop) => stop.text) ?? [];
  // A private page's description says nothing of what is inside it.
  const description = pageDescription(!indexable ? [] : kind === "space" ? [about, spoken] : [spoken, about], fallbackDescription(kind, place));
  const url = absolute(path);
  return {
    indexable, path, name, line: kindLine(kind, name, place, Boolean(text?.guided)), title, shareTitle, description, image,
    about: indexable ? about : [], text: indexable ? text : null, links: indexable ? links.filter((link) => link.url !== path) : [],
    author, host: home ? { name: brand, href: home } : undefined,
    jsonLd: pageJsonLd({ url, name, description, image: absolute(image), place: placeName, location: indexable ? location : undefined,
      coordinates: indexable ? text?.coordinates : undefined, created, updated, author: author && { name: author.name, url: absolute(author.path) },
      publisher: { id: home ? new URL("/#organization", home).href : undefined, name: brand, url: home ?? siteOrigin() } })
  };
}

/**
 * A space page. A space with a tour or hunt of its own is titled by it ("Save the Scrolls, a hunt in
 * the Byzantine Church, Petra"), and an older guided tour that shares its name with another public page
 * says it is the tour.
 */
export const spaceSearchPage = cache(async (sceneId: string): Promise<SearchPage | undefined> => {
  const scenes = await readAllScenes();
  const scene = scenes.find((item) => item.sceneId === sceneId);
  if (!scene) return undefined;
  const indexable = sceneSearchable(scene);
  const authored = readSceneTour(sceneId).experience;
  const own = authored?.stops.length ? authored : null;
  const twin = !own && indexable && guidedScene(scene)
    && scenes.some((other) => other.sceneId !== sceneId && sameTitle(other.title, scene.title) && sceneSearchable(other));
  const kind: PageKind = own ? own.kind : twin ? "tour" : "space";
  const info = readSpaceInfo(sceneId).info;
  const text = indexable ? await readText(scene, { experience: authored }) : null;
  return searchPage({ indexable, path: scene.scenePath, name: own?.title?.trim() || scene.title, place: scene.title, placeName: placeOf(scene, text), kind, text,
    about: paragraphs(info.description), image: scene.thumbnail, links: text?.links ?? [], location: info.location, created: scene.createdAt });
});

/** A customer's own tour or hunt page, named for itself and linking to its space and its maker. */
export const tourSearchPage = cache(async (tourId: string): Promise<SearchPage | undefined> => {
  const tour = readUserTour(tourId);
  const scene = tour && await tourScene(tour);
  if (!tour || !scene) return undefined;
  const indexable = tourSearchable(tour, scene);
  const text = indexable ? await readText(scene, { experience: tour.experience ?? emptyExperience(tour.kind), standalone: true }) : null;
  const creator = profileCard(tour.userId);
  const space = sceneSearchable(scene) ? [{ url: scene.scenePath, label: scene.title }] : [];
  return searchPage({ indexable, path: tourPath(tour), name: tour.title, place: scene.title, placeName: placeOf(scene, text), kind: tour.kind, text, about: [],
    image: tourThumbnail(tour.id) ?? scene.thumbnail, links: [...(text?.links ?? []), ...space].filter((link, index, all) => all.findIndex((other) => other.url === link.url) === index),
    author: { name: creator.name, path: creator.path }, location: readSpaceInfo(scene.sceneId).info.location, created: tour.created, updated: tour.updated });
});

export function searchMetadata(page: SearchPage): Metadata {
  return {
    title: { absolute: page.title }, description: page.description,
    ...(page.indexable ? {} : { robots: { index: false, follow: false } }),
    alternates: { canonical: page.path },
    openGraph: { type: "website", title: page.shareTitle, description: page.description, url: page.path, images: [{ url: page.image, alt: page.shareTitle }] },
    twitter: { card: "summary_large_image", title: page.shareTitle, description: page.description, images: [page.image] }
  };
}

/** Every page search engines may list: the public spaces, the shared tours and hunts on them, and the guides. */
export async function sitemapEntries(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();
  const scenes = await readAllScenes();
  const byId = new Map(scenes.map((scene) => [scene.sceneId, scene]));
  const spaces = scenes.filter(sceneSearchable).map((scene) => ({ url: `${origin}${scene.scenePath}`, lastModified: scene.createdAt }));
  const tours = accountsEnabled() ? listSharedTours().flatMap((tour) => {
    const scene = byId.get(tour.sceneId);
    return scene && tourSearchable(tour, scene) ? [{ url: `${origin}${tourPath(tour)}`, lastModified: tour.updated }] : [];
  }) : [];
  const guides = accountsEnabled() ? ["/learn", "/pricing"].map((page) => ({ url: `${origin}${page}` })) : [];
  return [...guides, ...spaces, ...tours];
}
