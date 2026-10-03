import { cleanText } from "@/lib/server/accounts-store";
import { accountResponse } from "@/lib/server/accounts";
import { EditConflict } from "@/lib/server/admin-store";
import { ExperienceError } from "@/lib/experience/validate";
import { parseExperienceFor } from "@/lib/server/tour-requests";
import { deleteUserTour, ownedTourRequest, saveUserTour, tourPath } from "@/lib/server/user-tours";
import { recordEvent } from "@/lib/server/analytics";

type Params = { params: Promise<{ id: string }> };

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
  const { user, tour, error } = await ownedTourRequest(request, (await params).id, 4096, { anySpace: true });
  if (error) return error;
  deleteUserTour(tour.id);
  void recordEvent("tour_deleted", { userId: user.id, props: { kind: tour.kind } });
  return accountResponse({ ok: true });
}
