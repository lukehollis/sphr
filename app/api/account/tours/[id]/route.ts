import { cleanText } from "@/lib/server/accounts-store";
import { accountResponse } from "@/lib/server/accounts";
import { EditConflict } from "@/lib/server/admin-store";
import { ExperienceError } from "@/lib/experience/validate";
import { parseExperienceFor } from "@/lib/server/tour-requests";
import { deleteUserTour, ownedTourRequest, saveUserTour, tourPath, type UserTour } from "@/lib/server/user-tours";
import { emptyExperience } from "@/lib/experience/types";
import { draftState } from "@/lib/server/tour-drafts";
import type { SceneListing } from "@/lib/scene-types";
import { recordEvent } from "@/lib/server/analytics";
import { experienceCatalog } from "@/lib/experience/catalog";

type Params = { params: Promise<{ id: string }> };

const describe = (tour: UserTour, scene?: SceneListing) => ({
  id: tour.id, title: tour.title, kind: tour.kind, public: tour.public, revision: tour.revision, path: tourPath(tour), editor: `/account/tours/${tour.id}`,
  space: scene ? { sceneId: scene.sceneId, title: scene.title, locations: scene.nodeCount, path: scene.scenePath } : null,
  experience: tour.experience ?? emptyExperience(tour.kind),
  draft: draftState(tour.id)
});

/**
 * One tour with its stops, objects, effects and looks, for editing by an agent, with
 * the looks, effects, sounds and shapes it can use (`?catalog=0` leaves those out).
 */
export async function GET(request: Request, { params }: Params) {
  const { tour, scene, error } = await ownedTourRequest(request, (await params).id, 0, { body: "none", anySpace: true });
  if (error) return error;
  const catalog = new URL(request.url).searchParams.get("catalog") !== "0";
  return accountResponse({ tour: describe(tour, scene), ...(catalog ? { catalog: experienceCatalog() } : {}) });
}

/** Renames a tour or changes who can open it, leaving its content as it is. */
export async function PATCH(request: Request, { params }: Params) {
  const { tour, body, error } = await ownedTourRequest(request, (await params).id, 4096);
  if (error) return error;
  const title = body?.title === undefined ? tour.title : cleanText(body.title, 200);
  if (!title) return accountResponse({ error: "Give the tour a title of 1–200 characters." }, 400);
  const shared = body?.public === undefined ? tour.public : body.public;
  if (typeof shared !== "boolean") return accountResponse({ error: "public must be true or false." }, 400);
  const saved = saveUserTour(tour.id, tour.revision, { experience: tour.experience ?? emptyExperience(tour.kind), title, public: shared });
  return accountResponse({ ok: true, tour: describe(saved) });
}

/** Saves a tour's stops, objects and effects with its title and sharing. */
export async function PUT(request: Request, { params }: Params) {
  const { user, body, tour, scene, error } = await ownedTourRequest(request, (await params).id, 2 * 1024 * 1024);
  if (error) return error;
  if (!Number.isSafeInteger(body?.revision) || body.revision < 0) return accountResponse({ error: "Reload the builder and try again." }, 400);
  const title = cleanText(body.title, 200);
  if (!title) return accountResponse({ error: "Give the tour a title of 1–200 characters." }, 400);
  if (typeof body.public !== "boolean") return accountResponse({ error: "Reload the builder and try again." }, 400);
  try {
    const saved = saveUserTour(tour.id, body.revision, { experience: await parseExperienceFor(scene!, body.experience), title, public: body.public });
    void recordEvent("tour_saved", { userId: user.id, props: { kind: saved.kind, stops: saved.experience?.stops.length ?? 0, public: saved.public } });
    return accountResponse({ ok: true, tour: { experience: saved.experience, revision: saved.revision, title: saved.title, public: saved.public, path: tourPath(saved) } });
  } catch (failure) {
    const status = failure instanceof EditConflict ? 409 : failure instanceof ExperienceError ? 400 : 500;
    if (status === 500) console.error("Unable to save a customer tour:", failure);
    return accountResponse({ error: status === 500 ? "Unable to save. Try again." : (failure as Error).message }, status);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  // Like spaces, tours are deleted only from the browser, never by a linked agent.
  const { user, tour, error } = await ownedTourRequest(request, (await params).id, 4096, { anySpace: true, agents: false });
  if (error) return error;
  deleteUserTour(tour.id);
  void recordEvent("tour_deleted", { userId: user.id, props: { kind: tour.kind } });
  return accountResponse({ ok: true });
}
