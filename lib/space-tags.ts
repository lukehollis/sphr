import type { Vector3Like } from "@/lib/types";

/**
 * A tag in a space, like a Mattertag: a pin on a surface that opens a card with a title, a
 * description and a photo, video or link. Tags imported with a capture are in its bootstrap
 * (`space.space_data.tags`, written by scripts/matterport/web_archive.py). An owner's edits are
 * kept by the app (lib/server/space-tags.ts) and replace them; restoring brings them back.
 */
export type SpaceTag = {
  id: string;
  title: string;
  /** Plain text; web addresses in it become links. */
  description?: string;
  /** The point on the surface the tag stands on, in meters, in the viewer's world frame. */
  position: Vector3Like;
  /** The way its stem leaves the surface; without one the disc sits on the point. */
  normal?: Vector3Like;
  /** The disc's color, #rrggbb. */
  color?: string;
  media?: TagMedia;
  /** Where an imported tag came from, such as "matterport". */
  source?: string;
  /** Placed in a panorama with no surface to stand on: it shows only from that panorama. */
  nodeId?: string;
};

export type TagMedia = { type: "image" | "video" | "link"; url: string };

export const tagLimits = { tags: 300, title: 200, description: 5000, url: 2000 } as const;
/** The colors the editor offers; the first is a new tag's. */
export const tagColors = ["#0098db", "#e03c31", "#f7c948", "#2e9d62", "#8b5cf6", "#ffffff", "#111111"] as const;
export const defaultTagColor = tagColors[0];

export class SpaceTagError extends Error {}

function text(value: unknown, max: number, label: string, multiline = false) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new SpaceTagError(`A tag's ${label} must be text.`);
  const cleaned = multiline
    ? value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim()
    : value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length > max) throw new SpaceTagError(`Keep a tag's ${label} under ${max} characters.`);
  return cleaned || undefined;
}

function vector(value: unknown, label: string): Vector3Like {
  const input = value as Partial<Vector3Like> | null;
  if (!input || typeof input !== "object" || !(["x", "y", "z"] as const).every(key => typeof input[key] === "number" && Number.isFinite(input[key]) && Math.abs(input[key]!) <= 1e6)) {
    throw new SpaceTagError(`A tag's ${label} is not a point in the space.`);
  }
  return { x: input.x!, y: input.y!, z: input.z! };
}

/**
 * Where a tag's media is: an https address, or a capture's own file (an imported tag's photo,
 * published beside its panoramas; a local checkout serves those from /datasets/).
 */
export function mediaAddress(value: string) {
  if (/^\/datasets\/[A-Za-z0-9._~/-]+$/.test(value) && !value.includes("..") && !value.includes("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname.includes(".") ? url.toString() : undefined;
  } catch { return undefined; }
}

function media(value: unknown): TagMedia | undefined {
  if (value === undefined || value === null) return undefined;
  const input = value as Partial<TagMedia>;
  if (typeof input !== "object" || !["image", "video", "link"].includes(input.type as string)) throw new SpaceTagError("A tag's media is a photo, a video or a link.");
  const raw = typeof input.url === "string" ? input.url.trim() : "";
  if (!raw) return undefined;
  const url = raw.length <= tagLimits.url ? mediaAddress(raw) : undefined;
  if (!url) throw new SpaceTagError("Give a tag's photo, video or link as a web address starting with https://.");
  return { type: input.type as TagMedia["type"], url };
}

/** Checks one tag, keeping only what is filled in. */
export function parseSpaceTag(value: unknown): SpaceTag {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpaceTagError("Send each tag as an object.");
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) throw new SpaceTagError("A tag has no usable ID. Reload the editor.");
  const title = text(input.title, tagLimits.title, "title");
  if (!title) throw new SpaceTagError("Give every tag a title.");
  const tag: SpaceTag = { id: input.id, title, position: vector(input.position, "position") };
  const description = text(input.description, tagLimits.description, "description", true);
  if (description) tag.description = description;
  if (input.normal !== undefined && input.normal !== null) {
    const normal = vector(input.normal, "direction");
    const length = Math.hypot(normal.x, normal.y, normal.z);
    if (length > 1e-6) tag.normal = { x: normal.x / length, y: normal.y / length, z: normal.z / length };
  }
  if (input.color !== undefined && input.color !== null) {
    if (typeof input.color !== "string" || !/^#[0-9a-f]{6}$/i.test(input.color)) throw new SpaceTagError("Choose a tag's color as #rrggbb.");
    tag.color = input.color.toLowerCase();
  }
  const attached = media(input.media);
  if (attached) tag.media = attached;
  if (typeof input.source === "string" && /^[a-z0-9-]{1,32}$/.test(input.source)) tag.source = input.source;
  if (input.nodeId !== undefined && input.nodeId !== null) {
    if (typeof input.nodeId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.nodeId)) throw new SpaceTagError("A tag's panorama is not in this space. Reload the editor.");
    tag.nodeId = input.nodeId;
  }
  return tag;
}

/** Checks the tags an editor sends: every one must be whole, and IDs must not repeat. */
export function parseSpaceTags(value: unknown): SpaceTag[] {
  if (!Array.isArray(value)) throw new SpaceTagError("Send the tags as a list.");
  if (value.length > tagLimits.tags) throw new SpaceTagError(`A space can have up to ${tagLimits.tags} tags.`);
  const tags = value.map(parseSpaceTag);
  if (new Set(tags.map(tag => tag.id)).size !== tags.length) throw new SpaceTagError("Two tags have the same ID. Reload the editor.");
  return tags;
}

/** The tags a capture came with, as the viewer shows them: any that fail the checks are left out. */
export function readableTags(value: unknown): SpaceTag[] {
  if (!Array.isArray(value)) return [];
  const tags: SpaceTag[] = [];
  const ids = new Set<string>();
  for (const item of value.slice(0, tagLimits.tags)) {
    try {
      const tag = parseSpaceTag(item);
      if (!ids.has(tag.id)) { ids.add(tag.id); tags.push(tag); }
    } catch { /* an unreadable tag is skipped, not the space */ }
  }
  return tags;
}

/** A new tag's ID, unlike the IDs already used. */
export function newTagId(taken: Iterable<string>) {
  const used = new Set(taken);
  for (;;) {
    const id = `tag-${Math.random().toString(36).slice(2, 10)}`;
    if (!used.has(id)) return id;
  }
}

/** A tag's text as plain runs and web addresses, so a card can link the addresses without reading markup. */
export function textRuns(value: string): { text: string; href?: string }[] {
  const runs: { text: string; href?: string }[] = [];
  let last = 0;
  for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    let address = match[0];
    // Punctuation after an address ends the sentence, and a closing bracket belongs to the text unless the address opened one.
    while (/[.,;:!?'"]$/.test(address) || (address.endsWith(")") && (address.match(/\(/g)?.length ?? 0) < (address.match(/\)/g)?.length ?? 0))) address = address.slice(0, -1);
    const start = match.index ?? 0;
    const href = mediaAddress(address) ?? (/^http:\/\//.test(address) ? safeHttp(address) : undefined);
    if (!href) continue;
    if (start > last) runs.push({ text: value.slice(last, start) });
    runs.push({ text: address, href });
    last = start + address.length;
  }
  if (last < value.length) runs.push({ text: value.slice(last) });
  return runs;
}

function safeHttp(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && !url.username && !url.password && url.hostname.includes(".") ? url.toString() : undefined;
  } catch { return undefined; }
}

/** How a tag's video plays in its card: a player from YouTube or Vimeo, a video file, or (null) a link out. */
export function videoPlayer(address: string): { kind: "frame" | "file"; src: string } | null {
  let url: URL;
  try { url = new URL(address, "https://example.invalid"); } catch { return null; }
  const host = url.hostname.replace(/^(www|m)\./, "");
  const youtube = host === "youtu.be" ? url.pathname.slice(1)
    : host === "youtube.com" || host === "youtube-nocookie.com"
      ? url.searchParams.get("v") ?? url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1]
      : undefined;
  if (youtube && /^[A-Za-z0-9_-]{6,20}$/.test(youtube)) return { kind: "frame", src: `https://www.youtube-nocookie.com/embed/${youtube}` };
  const vimeo = host === "vimeo.com" ? url.pathname.match(/^\/(\d{4,})/)?.[1] : host === "player.vimeo.com" ? url.pathname.match(/^\/video\/(\d{4,})/)?.[1] : undefined;
  if (vimeo) return { kind: "frame", src: `https://player.vimeo.com/video/${vimeo}` };
  if (/\.(mp4|webm|m4v|mov)$/i.test(url.pathname)) return { kind: "file", src: address };
  return null;
}
