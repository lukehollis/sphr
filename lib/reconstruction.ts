import type { ReconstructionConfig } from "@/lib/types";

const finite = (value: unknown, limit = 1e7): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
const numbers = (value: unknown, length: number, limit?: number) => Array.isArray(value) && value.length === length && value.every((item) => finite(item, limit));
const color = (value: unknown) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined;
const words = (value: unknown, limit: number) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit) : "";

/**
 * A reconstruction manifest checked field by field: a bad placement or a
 * missing model makes the whole manifest unusable, while a bad landmark or an
 * overlong title is dropped or trimmed. Null when it cannot be shown.
 */
export function parseReconstruction(value: unknown): ReconstructionConfig | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.version !== undefined && input.version !== 1) return null;
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model || model.length > 2000) return null;
  if (input.position !== undefined && !numbers(input.position, 3)) return null;
  if (input.quaternion !== undefined && !numbers(input.quaternion, 4, 2)) return null;
  if (input.scale !== undefined && !(finite(input.scale, 1e5) && input.scale > 0)) return null;
  const quaternion = input.quaternion as [number, number, number, number] | undefined;
  if (quaternion && Math.hypot(...quaternion) < 1e-6) return null;
  const title = words(input.title, 200);
  const credit = words(input.credit, 300);
  const variantIds = new Set<string>();
  const variants = (Array.isArray(input.variants) ? input.variants : []).slice(0, 12).flatMap((item) => {
    const variant = item as Record<string, unknown> | null;
    const id = typeof variant?.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(variant.id) ? variant.id : "";
    const title = words(variant?.title, 120);
    if (!id || !title || variantIds.has(id)) return [];
    variantIds.add(id);
    return [{ id, title }];
  });
  const landmarks = (Array.isArray(input.landmarks) ? input.landmarks : []).slice(0, 200).flatMap((item) => {
    const landmark = item as Record<string, unknown> | null;
    const name = words(landmark?.name, 120);
    return name && numbers(landmark?.position, 3) ? [{ name, position: [...landmark!.position as number[]] as [number, number, number] }] : [];
  });
  const skyInput = input.sky as Record<string, unknown> | undefined;
  const sky = skyInput && typeof skyInput === "object" ? { ...(color(skyInput.zenith) ? { zenith: color(skyInput.zenith) } : {}), ...(color(skyInput.horizon) ? { horizon: color(skyInput.horizon) } : {}) } : {};
  return {
    version: 1,
    model,
    ...(variants.length ? { variants } : {}),
    ...(title ? { title } : {}),
    ...(credit ? { credit } : {}),
    ...(input.position ? { position: [...input.position as number[]] as [number, number, number] } : {}),
    ...(quaternion ? { quaternion: [...quaternion] } : {}),
    ...(input.scale !== undefined ? { scale: input.scale as number } : {}),
    ...(landmarks.length ? { landmarks } : {}),
    ...(Object.keys(sky).length ? { sky } : {})
  };
}

/**
 * The model's address, relative to the manifest (or to the page for a manifest
 * written into the space). Only https, or http on this computer for testing.
 */
export function reconstructionModelUrl(config: ReconstructionConfig, manifestUrl: string | null, pageUrl: string) {
  try {
    const url = new URL(config.model, manifestUrl ? new URL(manifestUrl, pageUrl) : pageUrl);
    const local = url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
    return url.protocol === "https:" || local || url.origin === new URL(pageUrl).origin ? url.href : null;
  } catch {
    return null;
  }
}
