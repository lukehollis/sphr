import { allowAttempt } from "@/lib/server/admin-store";
import { accountRequest, accountResponse, attemptKey } from "@/lib/server/accounts";
import { readAllScenes } from "@/lib/scene-catalog";
import { canBuildOn, createUserTour, isOperatorScene, TourLimitError } from "@/lib/server/user-tours";
import { recordEvent } from "@/lib/server/analytics";
import { notifyTeam } from "@/lib/server/team-notify";

/** Starts a guided tour or scavenger hunt on one of the customer's spaces or one of the operator's public spaces. */
export async function POST(request: Request) {
  const { user, body, error } = await accountRequest(request);
  if (error) return error;
  if (!user.emailVerified) return accountResponse({ error: "Confirm your email address before making a tour." }, 403);
  const kind = body?.kind === "hunt" ? "hunt" : "tour";
  const scene = typeof body?.sceneId === "string" ? (await readAllScenes()).find(item => item.sceneId === body.sceneId) : undefined;
  if (!scene || !canBuildOn(user.id, scene)) return accountResponse({ error: "That space is not available to build on." }, 404);
  if (!allowAttempt([[attemptKey("tour", user.id), 60]], 60 * 60 * 1000)) return accountResponse({ error: "Too many new tours. Try again later." }, 429);
  try {
    // The space's name is a fine first title; the builder shows what kind of tour it is.
    const tour = createUserTour(user.id, scene.sceneId, scene.title.slice(0, 200), kind);
    const space = isOperatorScene(scene.sceneId) ? "Spacery" : "Their own";
    void recordEvent("tour_created", { userId: user.id, props: { kind, space: space === "Spacery" ? "spacery" : "own" } });
    void notifyTeam({ title: kind === "hunt" ? "Scavenger hunt started" : "Tour started", fields: [["Space", scene.title], ["Whose space", space], ["Account", user.email]] });
    return accountResponse({ ok: true, tour: { id: tour.id, editor: `/account/tours/${tour.id}` } });
  } catch (failure) {
    if (failure instanceof TourLimitError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
