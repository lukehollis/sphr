/**
 * Where a space's drawn versions (line drawings, watercolor) are indexed, made
 * offline by scripts/lines. Set SPHR_LINES_BASE_URL to the folder that holds
 * `<sceneId>/index.json`; without it, looks draw lines in the shader instead.
 */
export function variantsUrl(sceneId: string) {
  const base = process.env.SPHR_LINES_BASE_URL?.trim();
  return base && /^[a-f0-9]{12}$/.test(sceneId) ? `${base.replace(/\/$/, "")}/${sceneId}/index.json` : null;
}
