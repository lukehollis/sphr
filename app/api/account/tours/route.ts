import { allowAttempt } from "@/lib/server/admin-store";
import { accountRequest, accountResponse, attemptKey, publicOrigin } from "@/lib/server/accounts";
import { readAllScenes } from "@/lib/scene-catalog";
import { canBuildOn, createUserTour, describeTours, readyToBuild, TourLimitError, tourPath, tourUser } from "@/lib/server/user-tours";
import { spaceForScene } from "@/lib/server/accounts-store";
import { recordEvent } from "@/lib/server/analytics";
import { notifyTeam } from "@/lib/server/team-notify";

/** The customer's tours, newest edits first, with their links. */
export async function GET(request: Request) {
  const { user, error } = await tourUser(request);
  if (error) return error;
  return accountResponse({ tours: await describeTours(user.id) });
}

/** Starts a guided tour or scavenger hunt on one of the customer's spaces or one of the operator's public spaces. */
export async function POST(request: Request) {
  const { user, body, error } = await accountRequest(request, 4096, { agents: true });
  if (error) return error;
  if (!user.emailVerified) return accountResponse({ error: "Confirm your email address before making a tour." }, 403);
  const kind = body?.kind === "hunt" ? "hunt" : "tour";
  const scene = typeof body?.sceneId === "string" ? (await readAllScenes()).find(item => item.sceneId === body.sceneId) : undefined;
  if (!scene || !canBuildOn(user.id, scene)) return accountResponse({ error: "That space is not available to build on." }, 404);
  if (!readyToBuild(user.id)) {
    const plan = `${publicOrigin(request)}/account/plan?build=${scene.sceneId}`;
    return accountResponse({ error: `Choose a plan before making a tour. Tours and scavenger hunts are included on every plan. Choose one at ${plan}`, plan }, 402);
  }
  if (!allowAttempt([[attemptKey("tour", user.id), 60]], 60 * 60 * 1000)) return accountResponse({ error: "Too many new tours. Try again later." }, 429);
  try {
    // The space's name is a fine first title; the builder shows what kind of tour it is.
    const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : scene.title.slice(0, 200);
    const tour = createUserTour(user.id, scene.sceneId, title, kind);
    const owner = spaceForScene(scene.sceneId)?.userId;
    const space = owner === undefined ? "spacery" : owner === user.id ? "own" : "shared";
    void recordEvent("tour_created", { userId: user.id, props: { kind, space } });
    void notifyTeam({ title: kind === "hunt" ? "Scavenger hunt started" : "Tour started",
      fields: [["Space", scene.title], ["Whose space", { spacery: "Spacery", own: "Their own", shared: "Someone else's" }[space]], ["Account", user.email]] });
    return accountResponse({ ok: true, tour: { id: tour.id, title: tour.title, kind: tour.kind, editor: `/account/tours/${tour.id}`, path: tourPath(tour) } });
  } catch (failure) {
    if (failure instanceof TourLimitError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
