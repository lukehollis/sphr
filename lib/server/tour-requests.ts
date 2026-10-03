import { openingSpace } from "@/lib/scene-edits";
import { parseExperience } from "@/lib/experience/validate";
import { emptyExperience } from "@/lib/experience/types";
import type { SceneListing } from "@/lib/scene-types";
import { readSceneBootstrap } from "./scene-editor";
import { composeTour, TourAgentError, type AgentTurn, type ClientView } from "./tour-agent";
import { placeOnServer } from "./tour-placement";
import { captureMeshes } from "./capture-mesh";
import { variantsUrl } from "./variants";

/** The drawn versions of a space the looks can use: its line-drawing manifest's styles and companion splats. */
async function drawnVersions(scene: SceneListing, splats: { role?: string }[] = []) {
  const styles = new Set(splats.flatMap((splat) => splat.role === "sketch" ? ["contour"] : splat.role === "watercolor" ? ["watercolor"] : []));
  const url = variantsUrl(scene.sceneId);
  if (url) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (response.ok) for (const style of Object.keys((await response.json())?.styles ?? {})) styles.add(style);
    } catch { /* no drawn version is fine */ }
  }
  return [...styles];
}

/** Check a saved tour against the space it is for: stops must stand on the space's own panorama locations. */
export async function parseExperienceFor(scene: SceneListing, value: unknown) {
  const data = openingSpace(await readSceneBootstrap(scene)).space_data;
  const nodes = data.noPanos ? [] : data.nodes ?? data.navPoints ?? [];
  return parseExperience(value, { nodeIds: nodes.length ? new Set(nodes.map(node => node.uuid)) : undefined });
}

/**
 * Ask the tour agent for a new draft from a builder's request body. Nothing is saved.
 * With `place`, positions are worked out here rather than in a browser (for agents).
 */
export async function draftFromRequest(scene: SceneListing, body: Record<string, unknown> | null | undefined, origin: string, team: boolean, { place = false } = {}) {
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > 6000) throw new TourAgentError("Describe the tour in up to 6000 characters.");
  const bootstrap = await readSceneBootstrap(scene);
  const space = openingSpace(bootstrap);
  let draft;
  try { draft = parseExperience(body?.experience, { lenient: true }); } catch { draft = emptyExperience(); }
  const history: AgentTurn[] = Array.isArray(body?.history) ? body.history.slice(-6).flatMap((turn: unknown) => {
    const item = turn as Record<string, unknown>;
    return typeof item?.prompt === "string" && typeof item.reply === "string" ? [{ prompt: item.prompt.slice(0, 2000), reply: item.reply.slice(0, 1000) }] : [];
  }) : [];
  const views: ClientView[] = Array.isArray(body?.views) ? body.views.slice(0, 4).flatMap((view: unknown) => {
    const item = view as Record<string, unknown>;
    return typeof item?.id === "string" && typeof item.image === "string" ? [{ id: item.id.slice(0, 40), image: item.image,
      nodeId: typeof item.nodeId === "string" ? item.nodeId : undefined,
      rotation: item.rotation as ClientView["rotation"], fov: typeof item.fov === "number" ? item.fov : undefined }] : [];
  }) : [];
  const drawn = await drawnVersions(scene, space.space_data.splats as { role?: string }[] | undefined);
  const result = await composeTour({ bootstrap: { ...bootstrap, space }, draft, prompt, history, views, origin, kind: body?.kind === "hunt" ? "hunt" : "tour", team, drawn });
  if (place) {
    // Placed against the capture mesh like the builder does; without it, against each location's floor.
    const meshes = await captureMeshes(bootstrap).catch((failure) => { console.warn("Placing without the capture mesh:", (failure as Error).message); return []; });
    return { experience: placeOnServer(bootstrap, result.experience, result.anchors, meshes), anchors: { objects: {}, stops: {}, effects: {} }, reply: result.reply };
  }
  return { experience: result.experience, anchors: result.anchors, reply: result.reply };
}
