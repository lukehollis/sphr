/**
 * Where a space's drawn versions (line drawings, watercolor) are indexed, made
 * offline by scripts/lines. Set SPHR_LINES_BASE_URL to the folder that holds
 * `<sceneId>/index.json`; without it, looks draw lines in the shader instead.
 */
export function variantsUrl(sceneId: string) {
  const base = process.env.SPHR_LINES_BASE_URL?.trim();
  return base && /^[a-f0-9]{12}$/.test(sceneId) ? `${base.replace(/\/$/, "")}/${sceneId}/index.json` : null;
}

const known = new Map<string, { at: number; found: boolean }>();

/**
 * The manifest's address only when the space has drawn versions, so the viewer never
 * asks for one that is not there. Answers are remembered for ten minutes, so drawings
 * uploaded later appear within that time.
 */
export async function existingVariantsUrl(sceneId: string) {
  const url = variantsUrl(sceneId);
  if (!url) return null;
  const cached = known.get(url);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.found ? url : null;
  let found = cached?.found ?? false;
  try { found = (await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) })).ok; } catch { /* keep the last answer */ }
  known.set(url, { at: Date.now(), found });
  if (known.size > 2000) known.delete(known.keys().next().value!);
  return found ? url : null;
}
