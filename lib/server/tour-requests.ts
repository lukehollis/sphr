import { openingSpace } from "@/lib/scene-edits";
import { parseExperience } from "@/lib/experience/validate";
import { emptyExperience } from "@/lib/experience/types";
import type { SceneListing } from "@/lib/scene-types";
import { readSceneBootstrap } from "./scene-editor";
import { composeTour, TourAgentError, type AgentTurn, type ClientView } from "./tour-agent";

/** Check a saved tour against the space it is for: stops must stand on the space's own panorama locations. */
export async function parseExperienceFor(scene: SceneListing, value: unknown) {
  const data = openingSpace(await readSceneBootstrap(scene)).space_data;
  const nodes = data.noPanos ? [] : data.nodes ?? data.navPoints ?? [];
  return parseExperience(value, { nodeIds: nodes.length ? new Set(nodes.map(node => node.uuid)) : undefined });
}

/** Ask the tour agent for a new draft from a builder's request body. Nothing is saved. */
export async function draftFromRequest(scene: SceneListing, body: Record<string, unknown> | null | undefined, origin: string, team: boolean) {
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
  const result = await composeTour({ bootstrap: { ...bootstrap, space }, draft, prompt, history, views, origin, kind: body?.kind === "hunt" ? "hunt" : "tour", team });
  return { experience: result.experience, anchors: result.anchors, reply: result.reply };
}
