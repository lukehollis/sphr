import type { CameraRotation, Vector3Like } from "@/lib/types";

/**
 * Links and embed codes that open a space at a chosen view. A link carries one of
 * `?stop=3` (a guided tour's third stop), `?at=<panorama>&look=95,-19&fov=60` (standing at a
 * panorama, turned that way) or `?pos=1.2,1.6,-3&look=95,-19&fov=60` (where the camera stood, in a
 * space without panoramas), and `?tags=0` to hide tags.
 */

/** A spot a link opens at: a panorama, or a camera position where there are none. */
export type EntryView = { nodeId?: string; position?: Vector3Like; rotation: CameraRotation; fov?: number };

/** What a shared link asks for: a tour stop (from 0), or a spot and the way to look from it. */
export type LinkEntry = { stop?: number; view?: EntryView };

/** The view the share panel offers: the tour stop on screen, or the spot the visitor stands at. */
export type ShareView = { stop: number } | ({ nodeId: string } & Omit<EntryView, "nodeId" | "position">) | ({ position: Vector3Like } & Omit<EntryView, "nodeId" | "position">);

const finite = (value: number, limit: number) => Number.isFinite(value) && Math.abs(value) <= limit;

function look(params: URLSearchParams) {
  const [azimuth, polar] = (params.get("look") ?? "").split(",").map(Number);
  const fov = Number(params.get("fov"));
  return {
    rotation: { azimuth: finite(azimuth, 1e4) ? azimuth : 0, polar: Number.isFinite(polar) ? Math.max(-89, Math.min(89, polar)) : 0 },
    ...(params.has("fov") && Number.isFinite(fov) && fov >= 30 && fov <= 110 ? { fov } : {})
  };
}

/**
 * Where a link opens: a panorama of the opening space (`at`), a camera position in a space
 * without panoramas (`pos`), or a stop of its guided tour (`stop`). Anything else opens as usual.
 */
export function readLinkEntry(params: URLSearchParams, space: { nodes: string[]; stops: number; free: boolean }): LinkEntry {
  const at = params.get("at");
  if (at && space.nodes.includes(at)) return { view: { nodeId: at, ...look(params) } };
  const pos = (params.get("pos") ?? "").split(",").map(Number);
  if (space.free && params.has("pos") && pos.length === 3 && pos.every((value) => finite(value, 1e6))) {
    return { view: { position: { x: pos[0], y: pos[1], z: pos[2] }, ...look(params) } };
  }
  const stop = Number(params.get("stop"));
  return Number.isInteger(stop) && stop >= 1 && stop <= space.stops ? { stop: stop - 1 } : {};
}

const round = (value: number, places: number) => String(Number(value.toFixed(places)));

/** The space's address with the view (and hidden tags) a link opens at. */
export function shareUrl(base: string, view: ShareView | null, options: { tags?: boolean } = {}) {
  const url = new URL(base);
  url.search = "";
  url.hash = "";
  if (view && "stop" in view) url.searchParams.set("stop", String(view.stop + 1));
  else if (view) {
    if ("nodeId" in view) url.searchParams.set("at", view.nodeId);
    else url.searchParams.set("pos", [view.position.x, view.position.y, view.position.z].map((value) => round(value, 2)).join(","));
    url.searchParams.set("look", `${round(view.rotation.azimuth, 1)},${round(view.rotation.polar, 1)}`);
    if (view.fov !== undefined) url.searchParams.set("fov", String(Math.round(view.fov)));
  }
  if (options.tags === false) url.searchParams.set("tags", "0");
  return url.toString().replace(/%2C/gi, ",");
}

const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * An iframe that shows the space on another site at the width of its column. It may go full
 * screen, into a VR headset, and use a phone's motion to look around.
 */
export function embedCode(url: string, title: string) {
  return `<iframe src="${attribute(url)}" title="${attribute(title)}" width="100%" height="560" style="border:0;max-width:100%" `
    + `allow="fullscreen; xr-spatial-tracking; accelerometer; gyroscope; autoplay" allowfullscreen loading="lazy"></iframe>`;
}
