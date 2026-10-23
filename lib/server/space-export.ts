import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { applySceneEdits, openingSpace } from "../scene-edits";
import { readableTags } from "../space-tags";
import type { SceneListing } from "../scene-types";
import type { SphrBootstrap } from "../types";
import { isScenePublic, readSceneEdits } from "./admin-store";
import { spaceForScene } from "./accounts-store";
import { accountsEnabled } from "./accounts";
import { siteBrand, sourceUrl } from "./brand";
import { listPublishedRevision } from "./published-assets";
import { readSceneBootstrap } from "./scene-editor";
import { readSpaceInfo } from "./space-info";
import { readSpaceTags } from "./space-tags";
import { readSceneTour } from "./tours";
import { listUserTours, tourModelFile, tourPath } from "./user-tours";
import { bufferFile, safeZipName, type ZipFile } from "./zip";

/**
 * Everything that makes up a space, as plain files an owner can keep anywhere: its
 * published capture (panoramas, mesh, splats or model, exactly as stored), the scene file
 * the viewer reads with every address made a path in the download, its tags, details and
 * tours, and a README that says what each file is. Nothing here is read into memory but
 * the small JSON files; the capture's files stream from storage when the zip reaches them.
 */

type Source = { path: string; size: number | null; modified?: Date; open: (signal: AbortSignal) => Promise<{ size: number | null; chunks: AsyncIterable<Uint8Array> }> };

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
// File extensions of things a tag or tour shows or plays, to tell files on other websites from links to pages.
const mediaFile = /\.(jpe?g|png|webp|gif|avif|glb|gltf|ply|splat|ksplat|spz|mp3|m4a|ogg|wav|mp4|webm|mov|hdr|exr)$/i;

/** A path under the space's folder made from part of an address, or null when it would leave the folder. */
function relativePath(value: string) {
  try {
    const parts = value.split("/").map((part) => decodeURIComponent(part));
    const joined = parts.join("/");
    return safeZipName(joined) && parts.every((part) => /^[\p{L}\p{N} ._~()+,@=-]+$/u.test(part)) ? joined : null;
  } catch { return null; }
}

/** Replaces every string in a JSON value that `rewrite` maps, leaving the rest as it is. */
function mapStrings<T>(value: T, rewrite: (text: string) => string | undefined): T {
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return rewrite(item) ?? item;
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  };
  return visit(value) as T;
}

function eachString(value: unknown, take: (text: string) => void) {
  if (typeof value === "string") take(value);
  else if (Array.isArray(value)) value.forEach((item) => eachString(item, take));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => eachString(item, take));
}

async function response(url: string, signal: AbortSignal) {
  const result = await fetch(url, { headers: { "Accept-Encoding": "identity" }, redirect: "error", signal });
  if (!result.ok || !result.body) throw new Error(`Reading ${url} failed: HTTP ${result.status}`);
  return result;
}

const fromResponse = (result: Response) => ({
  size: result.headers.get("content-encoding") && result.headers.get("content-encoding") !== "identity" ? null
    : result.headers.has("content-length") ? Number(result.headers.get("content-length")) : null,
  // Node's fetch cancels a body once its response is garbage collected, so the response stays
  // reachable until its bytes are read (a file opened ahead can wait a while for its turn).
  chunks: (async function* () { for await (const chunk of result.body as unknown as AsyncIterable<Uint8Array>) yield chunk; })()
});

/** The files of a package on this site's own disk (public/datasets/...), walked from its folder. */
async function diskFiles(folder: string): Promise<Source[]> {
  const files: Source[] = [];
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = relativePath(path.relative(folder, file).split(path.sep).join("/"));
    if (!relative) continue;
    const info = await stat(file);
    files.push({ path: relative, size: info.size, modified: info.mtime,
      open: async (signal) => ({ size: info.size, chunks: createReadStream(file, { signal }) as unknown as AsyncIterable<Uint8Array> }) });
  }
  return files;
}

// Without a listing, the files the scene file names still come along, fetched by address.
const listingFailed = (error: unknown) => { console.error("Unable to list a space's published files:", error instanceof Error ? error.message : error); return null; };

/** The published files of a space: listed from storage or disk where possible, plus every file its scene file names in its folder. */
async function capturedFiles(scene: SceneListing, bootstrap: SphrBootstrap) {
  const folder = scene.bootstrapUrl.slice(0, -"bootstrap.json".length);
  const local = folder.startsWith("/datasets/");
  const files = new Map<string, Source>();
  if (local) for (const file of await diskFiles(path.join(process.cwd(), "public", folder))) files.set(file.path, file);
  else for (const file of await listPublishedRevision(scene.bootstrapUrl).catch(listingFailed) ?? []) {
    const relative = relativePath(file.path);
    if (relative) files.set(relative, { path: relative, size: file.size, modified: new Date(file.updated), open: async (signal) => fromResponse(await file.open(signal)) });
  }
  // Addresses in the scene file become paths in the download; files it names that no listing showed are fetched by address.
  const paths = new Map<string, string>();
  eachString(bootstrap, (text) => {
    if (!text.startsWith(folder) || paths.has(text)) return;
    const relative = relativePath(text.slice(folder.length).split(/[?#]/)[0]);
    if (!relative) return;
    paths.set(text, relative);
    if (!files.has(relative) && !local) files.set(relative, { path: relative, size: null, open: async (signal) => fromResponse(await response(text, signal)) });
  });
  // The scene file is written anew, with those paths.
  files.delete("bootstrap.json");
  return { files: [...files.values()], paths };
}

/** The team's own tours and hunts on this space, and the models and skies uploaded to any of the team's tours. */
function teamTours(sceneId: string) {
  const owner = accountsEnabled() ? spaceForScene(sceneId) : undefined;
  if (!owner || owner.status === "deleted") return { tours: [], ids: new Set<string>() };
  const all = listUserTours(owner.userId);
  return { tours: all.filter((tour) => tour.sceneId === sceneId), ids: new Set(all.map((tour) => tour.id)) };
}

const describe: Record<string, (count: number) => string> = {
  "README.txt": () => "This file.",
  "bootstrap.json": () => "The space as the viewer reads it: the places the camera stood and how they connect, the start view, the tags, and every file below, named by its path in this folder.",
  "details.json": () => "The title, link and details shown with the space, such as its description, location and who captured it.",
  "tags.json": () => "The tags pinned to the space's surfaces, with their titles, text, colors and media. Positions are in the same coordinates as the panoramas and the mesh.",
  "tour.json": () => "The space's guided tour or scavenger hunt: its stops, their text and views, placed objects, effects, looks and skies.",
  "tours": (count) => `${count === 1 ? "One tour or scavenger hunt" : `${count} tours and scavenger hunts`} your team made on this space, each with its title and link.`,
  "tour-files": (count) => `${count === 1 ? "A model or sky" : `${count} models and skies`} uploaded to your tours. The tour files name them by their path here.`,
  "faces": (count) => `The panoramas as cube faces, ${count} JPEG images. Each folder holds the six faces of one place the camera stood: face0 looks up, face1 to face4 look around the horizon in turn, and face5 looks down. That place's entry under nodes in bootstrap.json names its faces, and its position and quaternion put the cube in the space.`,
  "pano": (count) => `The panoramas as 360 photos, ${count === 1 ? "one equirectangular JPEG image" : `${count} equirectangular JPEG images`}, one for each place the camera stood.`,
  "mesh": () => "The capture mesh as a glTF binary (.glb), which opens in Blender and most 3D tools. It is in the same coordinates as the panoramas and the tags.",
  "splat": () => "The Gaussian splats or point cloud. A .ply file opens in splat and point cloud tools such as SuperSplat and CloudCompare. A .splat file holds 32 bytes for each splat: its position, scale, color and rotation.",
  "model": () => "The 3D model as a glTF binary (.glb), which opens in Blender and most 3D tools.",
  "preview.jpg": () => "The picture that stands for the space in lists and when it is shared."
};

function readme({ title, link, brand, downloaded, entries, external, source }: { title: string; link: string; brand: string; downloaded: string;
  entries: string[]; external: string[]; source?: string }) {
  const groups = new Map<string, number>();
  const folders = new Set<string>();
  for (const entry of entries) {
    const [top, ...rest] = entry.split("/");
    groups.set(top, (groups.get(top) ?? 0) + 1);
    if (rest.length) folders.add(top);
  }
  const known = Object.keys(describe).filter((key) => groups.has(key));
  const other = [...groups.keys()].filter((key) => !describe[key]).sort();
  const name = (key: string) => folders.has(key) ? `${key}/` : key;
  const width = Math.max(...[...known, ...other].map((key) => name(key).length)) + 3;
  const lines = [
    title, "",
    `This folder holds everything that makes up this space on ${brand}, as plain files you can keep anywhere. It was downloaded on ${downloaded} from ${link}`, "",
    "Every file path in the JSON files is relative to this folder.", "",
    "What each file is", "",
    ...known.map((key) => `${name(key).padEnd(width)}${describe[key](groups.get(key)!)}`),
    ...other.map((key) => `${name(key).padEnd(width)}Another file the viewer uses for this space.`)
  ];
  if (external.length) lines.push("", "Files on other websites", "",
    "Some tags and tours show files kept on other websites. They are not in this folder, and the tags and tours name them by these addresses.", "", ...external);
  if (source) lines.push("", `The viewer that reads bootstrap.json is open source, at ${source}`);
  return Buffer.from(`${lines.join("\n")}\n`);
}

export class ExportUnavailable extends Error {}

/**
 * The files of a space's download, in the order they are written (small descriptions first,
 * so even a download stopped early holds them), all inside one folder named after the space.
 */
export async function spaceExport(scene: SceneListing, origin: string, now = new Date()): Promise<{ name: string; files: ZipFile[] }> {
  let bootstrap: SphrBootstrap;
  try { bootstrap = await readSceneBootstrap(scene); }
  catch (error) { throw new ExportUnavailable(error instanceof Error ? error.message : "The space's files are unavailable."); }
  const sceneId = scene.sceneId;
  const { files: captured, paths } = await capturedFiles(scene, bootstrap);
  const link = `${origin}${scene.scenePath}`;
  const atPath = (text: string) => paths.get(text);

  // Tours, and the files uploaded to them, which live with the site and are read from its disk.
  const { tours, ids } = teamTours(sceneId);
  const sceneTour = readSceneTour(sceneId).experience;
  const uploads = new Map<string, string>();
  const tourFile = (text: string) => {
    const match = text.match(/^\/api\/tour-files\/([a-f0-9]{12})\/([a-f0-9]{16}\.(?:glb|jpg|png|webp))$/);
    const found = match && ids.has(match[1]) ? tourModelFile(match[1], match[2]) : null;
    if (!match || !found) return undefined;
    uploads.set(`tour-files/${match[1]}/${match[2]}`, found.file);
    return `tour-files/${match[1]}/${match[2]}`;
  };
  const exportedTour = sceneTour ? mapStrings(sceneTour, (text) => atPath(text) ?? tourFile(text)) : null;
  const exportedTours = tours.map((tour) => ({ path: `tours/${tour.id}.json`, value: {
    id: tour.id, title: tour.title, kind: tour.kind, public: tour.public, link: `${origin}${tourPath(tour)}`, created: tour.created, updated: tour.updated,
    experience: tour.experience ? mapStrings(tour.experience, (text) => atPath(text) ?? tourFile(text)) : null
  } }));
  // Uploaded files are listed with their sizes so the download's length is known before it starts.
  const uploaded = await Promise.all([...uploads].map(async ([target, file]): Promise<Source> => {
    const info = await stat(file);
    return { path: target, size: info.size, modified: info.mtime,
      open: async (signal) => ({ size: info.size, chunks: createReadStream(file, { signal }) as unknown as AsyncIterable<Uint8Array> }) };
  }));

  // What visitors see: the owner's title, start view and tags over the published capture.
  const edits = readSceneEdits().get(sceneId);
  const ownerTags = readSpaceTags(sceneId).tags;
  const tags = mapStrings(ownerTags ?? readableTags(openingSpace(bootstrap).space_data.tags ?? []), atPath);
  const sceneFile = mapStrings(applySceneEdits(bootstrap, { title: scene.title, startView: edits?.startView ?? null, tags: ownerTags }), atPath);
  const details = { title: scene.title, link, visibility: isScenePublic(sceneId) ? "public" : "private", added: scene.createdAt || undefined,
    downloaded: now.toISOString(), ...readSpaceInfo(sceneId).info };

  const external = new Set<string>();
  eachString([tags, exportedTour, exportedTours.map((tour) => tour.value.experience)], (text) => {
    try { if (/^https:\/\//.test(text) && mediaFile.test(new URL(text).pathname)) external.add(text); } catch { /* Not an address. */ }
  });

  const generated: { path: string; bytes: Buffer }[] = [
    { path: "details.json", bytes: json(details) },
    { path: "tags.json", bytes: json(tags) },
    ...(exportedTour ? [{ path: "tour.json", bytes: json(exportedTour) }] : []),
    ...exportedTours.map((tour) => ({ path: tour.path, bytes: json(tour.value) })),
    { path: "bootstrap.json", bytes: json(sceneFile) }
  ];
  const media = [...uploaded, ...captured].sort((a, b) => (a.path === "preview.jpg" ? -1 : b.path === "preview.jpg" ? 1 : a.path.localeCompare(b.path)));
  const entries = ["README.txt", ...generated.map((file) => file.path), ...media.map((file) => file.path)];
  const folder = scene.titleSlug;
  const downloaded = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const notes = readme({ title: scene.title, link, brand: siteBrand(), downloaded, entries, external: [...external].sort(), source: sourceUrl() });
  return { name: folder, files: [
    bufferFile(`${folder}/README.txt`, notes, now),
    ...generated.map((file) => bufferFile(`${folder}/${file.path}`, file.bytes, now)),
    ...media.map((file) => ({ name: `${folder}/${file.path}`, size: file.size, modified: file.modified, open: file.open }))
  ] };
}
