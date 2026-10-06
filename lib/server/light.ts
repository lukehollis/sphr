import type { LightCopies } from "@/lib/types";

/**
 * Where a space's light copies are indexed: smaller panorama faces and a compressed capture
 * model, made offline by scripts/matterport/light_copies.py beside the published capture.
 * SPHR_LIGHT_BASE_URL is the folder that holds `<sceneId>/index.json`.
 */
export function lightUrl(sceneId: string) {
  const base = (process.env.SPHR_LIGHT_BASE_URL?.trim() || "https://static.mused.com/sphr/light").replace(/\/$/, "");
  return /^[a-f0-9]{12}$/.test(sceneId) ? `${base}/${sceneId}/index.json` : null;
}

const known = new Map<string, { at: number; copies: LightCopies | null }>();

const https = (value: unknown): value is string => typeof value === "string" && /^https:\/\/[^\s]+$/.test(value) && value.length < 500;

/** The index when it is whole: face addresses that fill in, sizes in range, models as address pairs. */
export function parseLightCopies(value: unknown): LightCopies | null {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return null;
  const { faces, models } = value as { faces?: unknown; models?: unknown };
  const copies: LightCopies = { version: 1 };
  if (faces && typeof faces === "object") {
    const { template, sizes, nodes } = faces as { template?: unknown; sizes?: unknown; nodes?: unknown };
    if (https(template) && ["{size}", "{uuid}", "{face}"].every((part) => template.includes(part))
      && Array.isArray(sizes) && sizes.length && sizes.every((size) => Number.isInteger(size) && size >= 128 && size <= 4096)
      && Array.isArray(nodes) && nodes.every((node) => typeof node === "string" && node.length < 200)) {
      copies.faces = { template, sizes: [...sizes].sort((a, b) => a - b), nodes };
    }
  }
  if (models && typeof models === "object" && !Array.isArray(models)) {
    const pairs = Object.entries(models).filter(([from, to]) => https(from) && https(to));
    if (pairs.length) copies.models = Object.fromEntries(pairs);
  }
  return copies.faces || copies.models ? copies : null;
}

/**
 * The space's light copies, or null when it has none. Answers are remembered for ten minutes,
 * so copies uploaded later are used within that time.
 */
export async function existingLightCopies(sceneId: string) {
  const url = lightUrl(sceneId);
  if (!url) return null;
  const cached = known.get(url);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.copies;
  let copies = cached?.copies ?? null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    copies = response.ok ? parseLightCopies(await response.json()) : response.status < 500 ? null : copies;
  } catch { /* keep the last answer */ }
  known.set(url, { at: Date.now(), copies });
  if (known.size > 2000) known.delete(known.keys().next().value!);
  return copies;
}
