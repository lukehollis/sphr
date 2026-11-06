import { openingSpace } from "@/lib/scene-edits";
import { parseExperience } from "@/lib/experience/validate";
import { emptyExperience } from "@/lib/experience/types";
import type { SceneListing } from "@/lib/scene-types";
import { readSceneBootstrap } from "./scene-editor";
import { composeTour, TourAgentError, type AgentTurn, type ClientView } from "./tour-agent";
import { findProblems, placeOnServer } from "./tour-placement";
import { reportProblem } from "./error-report";
import { captureMeshes } from "./capture-mesh";
import { spaceViews } from "./space-views";
import { variantsUrl } from "./variants";
import { describeReconstruction } from "./reconstructions";

/**
 * The drawn versions of a space the looks can use (its line-drawing manifest's styles and
 * companion splats), and "sky" when its 360 photos have sky outlines for tour skies.
 */
async function drawnVersions(scene: SceneListing, splats: { role?: string }[] = []) {
  const styles = new Set(splats.flatMap((splat) => splat.role === "sketch" ? ["contour"] : splat.role === "watercolor" ? ["watercolor"] : []));
  const url = variantsUrl(scene.sceneId);
  if (url) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const manifest = response.ok ? await response.json() : null;
      for (const style of Object.keys(manifest?.styles ?? {})) styles.add(style);
      if (Object.keys(manifest?.sky?.nodes ?? {}).length) styles.add("sky");
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

type DraftOptions = { place?: boolean; alsoPlace?: boolean; onLog?: (line: string) => void; tourId?: string };

/** An agent's answer can quote the request, so a log keeps only how long the quoted part was. */
export function agentErrorForLog(message: string) {
  return message.replace(/(did not return a JSON draft:)\s*([\s\S]*)$/, (_, said: string, rest: string) => `${said} (${rest.trim().length} characters of its answer left out)`).slice(0, 400);
}

/**
 * Ask the tour agent for a new draft from a builder's request body. Nothing is saved.
 * With `place`, positions are worked out here rather than in a browser (for agents).
 * A draft that fails is logged with its space and tour (never the request), and the
 * operator hears about each kind of failure once an hour.
 */
export async function draftFromRequest(scene: SceneListing, body: Record<string, unknown> | null | undefined, origin: string, team: boolean, options: DraftOptions = {}) {
  const where = `scene=${scene.sceneId} tour=${options.tourId ?? "-"} kind=${body?.kind === "hunt" ? "hunt" : "tour"}`;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > 6000) {
    console.warn(`[tour-agent] refused ${where}: the request was ${prompt ? `${prompt.length} characters` : "empty"}`);
    throw new TourAgentError("Describe the tour in up to 6000 characters.");
  }
  const started = Date.now();
  try {
    return await draftTour(scene, body, prompt, origin, team, options);
  } catch (failure) {
    const seconds = Math.round((Date.now() - started) / 1000);
    if (failure instanceof TourAgentError) {
      const message = agentErrorForLog(failure.message);
      console.warn(`[tour-agent] failed after ${seconds}s ${where}: ${message}`);
      reportProblem("Tour agent draft failed", message, [["Space", scene.sceneId], ["Tour", options.tourId], ["Kind", body?.kind === "hunt" ? "hunt" : "tour"], ["After", `${seconds} s`]]);
    } else console.error(`[tour-agent] failed after ${seconds}s ${where}:`, failure);
    throw failure;
  }
}

async function draftTour(scene: SceneListing, body: Record<string, unknown> | null | undefined, prompt: string, origin: string, team: boolean, { place = false, alsoPlace = false, onLog, tourId }: DraftOptions) {
  onLog?.(`Loading ${scene.title} 3D space data…`);
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
  const [drawn, reconstruction] = await Promise.all([
    drawnVersions(scene, space.space_data.splats as { role?: string }[] | undefined),
    describeReconstruction(scene.sceneId, space.space_data.reconstruction)
  ]);
  // A space without panoramas (a splat or a model) is shown to the agent in views drawn here.
  const drawnViews = await spaceViews(bootstrap, scene.sceneId).catch((failure) => { console.warn("Drafting without drawn views:", (failure as Error).message); return null; }) ?? [];
  const result = await composeTour({ bootstrap: { ...bootstrap, space }, draft, prompt, history, views, origin, kind: body?.kind === "hunt" ? "hunt" : "tour", team, drawn, spaceViews: drawnViews, reconstruction, onLog,
    meta: { scene: scene.sceneId, ...(tourId ? { tour: tourId } : {}) } });
  if (result.scrubbed) console.info(`[tour-agent] scene=${scene.sceneId} tour=${tourId ?? "-"}: took location names out of ${result.scrubbed} piece${result.scrubbed === 1 ? "" : "s"} of text`);
  let placed: ReturnType<typeof placeOnServer> | undefined;
  if (place || alsoPlace) {
    // Placed against the capture mesh like the builder does; without it, against each location's floor.
    onLog?.("Placing objects against the 3D capture mesh…");
    const meshes = await captureMeshes(bootstrap).catch((failure) => { console.warn("Placing without the capture mesh:", (failure as Error).message); return []; });
    placed = placeOnServer(bootstrap, result.experience, result.anchors, meshes, drawnViews);
    // Clues a player may never get past are named in the reply, which the builder and the email show.
    const problems = findProblems(bootstrap, placed, meshes);
    if (problems.length) {
      console.info(`[tour-agent] scene=${scene.sceneId} tour=${tourId ?? "-"}: finds out of reach at ${problems.map((item) => `clue ${item.index + 1} (${item.hidden ? "hidden" : `${item.distance} m`})`).join(", ")}`);
      result.reply = `${result.reply} ${findProblemsNote(problems)}`;
    }
    if (place) return { experience: placed, placed, anchors: { objects: {}, stops: {}, effects: {} }, reply: result.reply };
  }
  if (!drawnViews.length) return { experience: result.experience, placed, anchors: result.anchors, reply: result.reply };
  // In the builder, spots in the drawn views are placed here and the rest in the browser.
  const ours = new Set(drawnViews.map((view) => view.id));
  const split = (group: Record<string, { view?: string }>, mine: boolean) => Object.fromEntries(Object.entries(group).filter(([, anchor]) => Boolean(anchor.view && ours.has(anchor.view)) === mine));
  const here = { objects: split(result.anchors.objects, true), stops: split(result.anchors.stops, true), effects: split(result.anchors.effects, true) } as typeof result.anchors;
  const there = { objects: split(result.anchors.objects, false), stops: split(result.anchors.stops, false), effects: split(result.anchors.effects, false) } as typeof result.anchors;
  return { experience: placeOnServer(bootstrap, result.experience, here, [], drawnViews), placed, anchors: there, reply: result.reply };
}

/** What the owner reads about clues a player may never get past. */
export function findProblemsNote(problems: Array<{ index: number; distance: number; hidden?: boolean }>) {
  if (problems.length === 1) {
    const [item] = problems;
    return `Clue ${item.index + 1}'s object ${item.hidden ? "can't be seen from where the clue starts" : `is ${item.distance} meters from where the clue starts`}, so players may not find it. Check it in the builder.`;
  }
  const clues = problems.map((item) => String(item.index + 1));
  return `The objects for clues ${clues.slice(0, -1).join(", ")} and ${clues.at(-1)} are far from where their clues start or hard to see, so players may not find them. Check them in the builder.`;
}
