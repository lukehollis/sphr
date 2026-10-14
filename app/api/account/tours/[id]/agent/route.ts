import { accountResponse, attemptKey, notifyOwner, publicOrigin } from "@/lib/server/accounts";
import { allowAttempt } from "@/lib/server/admin-store";
import { siteBrand } from "@/lib/server/brand";
import { tourReadyEmail } from "@/lib/server/emails";
import { TourAgentError, tourAgentConfigured } from "@/lib/server/tour-agent";
import { draftFromRequest } from "@/lib/server/tour-requests";
import { tourThumbnail } from "@/lib/server/tour-thumbnails";
import { agentUnlimited, FREE_AGENT_DRAFTS, FREE_AGENT_WINDOW, ownedTourRequest, readUserTour, saveUserTour, tourPath } from "@/lib/server/user-tours";
import { EditConflict } from "@/lib/server/admin-store";
import { startDraft } from "@/lib/server/tour-drafts";
import { recordEvent } from "@/lib/server/analytics";
import type { Experience } from "@/lib/experience/types";

export const maxDuration = 300;

/**
 * Asks the tour agent for a new draft of a customer's tour. When the draft finishes, it is
 * placed against the 3D capture mesh, saved to the customer's tour, and emailed to them so
 * their work is ready even if they leave the page while the agent drafts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, body, tour, scene, error } = await ownedTourRequest(request, (await params).id, 10 * 1024 * 1024);
  if (error) return error;
  // Building is free; without a plan the agent drafts FREE_AGENT_DRAFTS times every 30 days.
  if (tourAgentConfigured() && !agentUnlimited(user.id)
    && !allowAttempt([[attemptKey("tour-agent-free", user.id), FREE_AGENT_DRAFTS]], FREE_AGENT_WINDOW)) {
    const plan = `${publicOrigin(request)}/account/plan?build=${tour.sceneId}`;
    return accountResponse({ error: `You've used your ${FREE_AGENT_DRAFTS} free drafts with the agent for this month. Building by hand stays free. Choose a plan to keep drafting: ${plan}`, plan }, 402);
  }
  // The agent runs on the operator's own machine, one request at a time.
  if (!allowAttempt([[attemptKey("tour-agent", user.id), 30], ["tour-agent-all", 400]], 60 * 60 * 1000)) {
    return accountResponse({ error: "Your agent has had a lot of requests this hour. Edit by hand for now, or try again later." }, 429);
  }
  const externalOrigin = publicOrigin(request);
  const saveAndEmail = (experience: Experience, reply: string, strictRevision: boolean) => {
    const current = strictRevision ? tour : (readUserTour(tour.id) ?? tour);
    const saved = saveUserTour(tour.id, current.revision, { experience, title: current.title, public: current.public });
    void notifyOwner(user, tourReadyEmail(siteBrand(), externalOrigin, {
      id: saved.id,
      title: saved.title,
      kind: saved.kind,
      path: tourPath(saved),
      public: saved.public,
      spaceTitle: scene!.title,
      thumbnail: tourThumbnail(saved.id) ?? scene!.thumbnail,
      reply,
      stops: (saved.experience ?? experience).stops,
      objects: (saved.experience ?? experience).objects
    }));
    return {
      id: saved.id, title: saved.title, kind: saved.kind, public: saved.public, revision: saved.revision,
      path: tourPath(saved), editor: `/account/tours/${saved.id}`, experience: saved.experience
    };
  };
  try {
    const save = body?.save === true || body?.async === true;
    const request_ = save ? { ...body, experience: body?.experience ?? tour.experience, kind: body?.kind ?? tour.kind } : body;
    if (body?.async === true) {
      // People's own agents: answer at once, draft in the background, and save when done.
      if (!tourAgentConfigured()) throw new TourAgentError("No agent is set up on this server. Edit the tour by hand with save_tour, or in the browser.");
      const origin = new URL(request.url).origin;
      const started = startDraft(tour.id, async () => {
        const result = await draftFromRequest(scene!, request_, origin, false, { place: true });
        saveAndEmail(result.experience, result.reply, true);
        void recordEvent("tour_agent", { userId: user.id, props: { stops: result.experience.stops.length, from: "agent" } });
        return result.reply;
      });
      if (!started) return accountResponse({ error: "A draft is already being made for this tour. Check the tour in a minute." }, 409);
      return accountResponse({ ok: true, drafting: true }, 202);
    }
    if (body?.stream === true) {
      const origin = new URL(request.url).origin;
      const encoder = new TextEncoder();
      const bodyStream = new ReadableStream({
        async start(controller) {
          const sendLine = (payload: Record<string, unknown>) => {
            try { controller.enqueue(encoder.encode(JSON.stringify(payload) + "\n")); } catch { /* stream closed */ }
          };
          const heartbeat = setInterval(() => sendLine({ type: "ping" }), 5000);
          try {
            const result = await draftFromRequest(scene!, request_, origin, false, {
              place: save,
              alsoPlace: true,
              onLog: (text) => sendLine({ type: "log", text })
            });
            void recordEvent("tour_agent", { userId: user.id, props: { stops: result.experience.stops.length, from: save ? "agent" : "builder" } });
            sendLine({ type: "log", text: "Saving draft and sending email notification…" });
            const savedTour = saveAndEmail(result.placed ?? result.experience, result.reply, save);
            if (!save) {
              sendLine({ type: "done", ok: true, ...result, tour: savedTour });
            } else {
              sendLine({ type: "done", ok: true, reply: result.reply, tour: savedTour });
            }
          } catch (failure) {
            if (failure instanceof TourAgentError) sendLine({ type: "error", status: 422, error: failure.message });
            else if (failure instanceof EditConflict) sendLine({ type: "error", status: 409, error: "The tour changed while the agent worked. Ask again." });
            else {
              console.error("Tour agent failed for a customer tour:", failure);
              sendLine({ type: "error", status: 502, error: "The agent could not finish. Try again." });
            }
          } finally {
            clearInterval(heartbeat);
            try { controller.close(); } catch { /* already closed */ }
          }
        }
      });
      return new Response(bodyStream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" }
      });
    }
    const result = await draftFromRequest(scene!, request_, new URL(request.url).origin, false, { place: save, alsoPlace: true });
    void recordEvent("tour_agent", { userId: user.id, props: { stops: result.experience.stops.length, from: save ? "agent" : "builder" } });
    const savedTour = saveAndEmail(result.placed ?? result.experience, result.reply, save);
    if (!save) return accountResponse({ ok: true, ...result, tour: savedTour });
    return accountResponse({ ok: true, reply: result.reply, tour: savedTour });
  } catch (failure) {
    if (failure instanceof TourAgentError) return accountResponse({ error: failure.message }, 422);
    if (failure instanceof EditConflict) return accountResponse({ error: "The tour changed while the agent worked. Ask again." }, 409);
    console.error("Tour agent failed for a customer tour:", failure);
    return accountResponse({ error: "The agent could not finish. Try again." }, 502);
  }
}
