import type { ReconstructionConfig } from "@/lib/types";
import { parseReconstruction } from "@/lib/reconstruction";

/**
 * Where a site's reconstruction manifest lives, built offline in Blender. Set
 * SPHR_RECONSTRUCTIONS_BASE_URL to the folder that holds `<sceneId>/index.json`
 * (see docs/tours-and-effects.md); without it, spaces show only their capture.
 */
export function reconstructionUrl(sceneId: string) {
  const base = process.env.SPHR_RECONSTRUCTIONS_BASE_URL?.trim();
  return base && /^[a-f0-9]{12}$/.test(sceneId) ? `${base.replace(/\/$/, "")}/${sceneId}/index.json` : null;
}

const known = new Map<string, { at: number; found: boolean }>();

/**
 * The manifest's address only when the space has a reconstruction, so the viewer never
 * asks for one that is not there. Answers are remembered for ten minutes, so a
 * reconstruction uploaded later appears within that time.
 */
export async function existingReconstructionUrl(sceneId: string) {
  const url = reconstructionUrl(sceneId);
  if (!url) return null;
  const cached = known.get(url);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.found ? url : null;
  let found = cached?.found ?? false;
  try { found = (await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) })).ok; } catch { /* keep the last answer */ }
  known.set(url, { at: Date.now(), found });
  if (known.size > 2000) known.delete(known.keys().next().value!);
  return found ? url : null;
}

/**
 * What the tour agent is told about a space's reconstruction: its title and
 * the names of its landmarks. From the space's own manifest, or the one beside
 * the published capture. Null when the space has none.
 */
export async function describeReconstruction(sceneId: string, own?: string | ReconstructionConfig) {
  let config = own && typeof own === "object" ? parseReconstruction(own) : null;
  const url = typeof own === "string" ? own : config ? null : reconstructionUrl(sceneId);
  if (!config && url && /^https?:\/\//.test(url)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (response.ok) config = parseReconstruction(await response.json());
    } catch { /* no reconstruction is fine */ }
  }
  if (!config) return null;
  return { title: config.title, landmarks: (config.landmarks ?? []).map((landmark) => landmark.name) };
}
