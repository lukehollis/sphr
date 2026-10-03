import { accountResponse, attemptKey } from "@/lib/server/accounts";
import { allowAttempt } from "@/lib/server/admin-store";
import { TourAgentError, tourAgentConfigured } from "@/lib/server/tour-agent";
import { draftFromRequest } from "@/lib/server/tour-requests";
import { ownedTourRequest, saveUserTour, tourPath } from "@/lib/server/user-tours";
import { EditConflict } from "@/lib/server/admin-store";
import { startDraft } from "@/lib/server/tour-drafts";
import { recordEvent } from "@/lib/server/analytics";

export const maxDuration = 300;

/**
 * Asks the tour agent for a new draft of a customer's tour. From the builder nothing is
 * saved until the customer saves. With `save: true` (people's own agents, which have no
 * browser to place things in) the draft is placed here, saved, and the tour returned.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, body, tour, scene, error } = await ownedTourRequest(request, (await params).id, 10 * 1024 * 1024);
  if (error) return error;
  // The agent runs on the operator's own machine, one request at a time.
  if (!allowAttempt([[attemptKey("tour-agent", user.id), 30], ["tour-agent-all", 400]], 60 * 60 * 1000)) {
    return accountResponse({ error: "Your agent has had a lot of requests this hour. Edit by hand for now, or try again later." }, 429);
  }
  try {
    const save = body?.save === true || body?.async === true;
    const request_ = save ? { ...body, experience: body?.experience ?? tour.experience, kind: body?.kind ?? tour.kind } : body;
    if (body?.async === true) {
      // People's own agents: answer at once, draft in the background, and save when done.
      if (!tourAgentConfigured()) throw new TourAgentError("No agent is set up on this server. Edit the tour by hand with save_tour, or in the browser.");
      const origin = new URL(request.url).origin;
      const started = startDraft(tour.id, async () => {
        const result = await draftFromRequest(scene!, request_, origin, false, { place: true });
        saveUserTour(tour.id, tour.revision, { experience: result.experience, title: tour.title, public: tour.public });
        void recordEvent("tour_agent", { userId: user.id, props: { stops: result.experience.stops.length, from: "agent" } });
        return result.reply;
      });
      if (!started) return accountResponse({ error: "A draft is already being made for this tour. Check the tour in a minute." }, 409);
      return accountResponse({ ok: true, drafting: true }, 202);
    }
    const result = await draftFromRequest(scene!, request_, new URL(request.url).origin, false, { place: save });
    void recordEvent("tour_agent", { userId: user.id, props: { stops: result.experience.stops.length, from: save ? "agent" : "builder" } });
    if (!save) return accountResponse({ ok: true, ...result });
    const saved = saveUserTour(tour.id, tour.revision, { experience: result.experience, title: tour.title, public: tour.public });
    return accountResponse({ ok: true, reply: result.reply, tour: { id: saved.id, title: saved.title, kind: saved.kind, public: saved.public, revision: saved.revision,
      path: tourPath(saved), editor: `/account/tours/${saved.id}`, experience: saved.experience } });
  } catch (failure) {
    if (failure instanceof TourAgentError) return accountResponse({ error: failure.message }, 422);
    if (failure instanceof EditConflict) return accountResponse({ error: "The tour changed while the agent worked. Ask again." }, 409);
    console.error("Tour agent failed for a customer tour:", failure);
    return accountResponse({ error: "The agent could not finish. Try again." }, 502);
  }
}
