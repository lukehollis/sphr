import { accountResponse, attemptKey } from "@/lib/server/accounts";
import { allowAttempt } from "@/lib/server/admin-store";
import { TourAgentError } from "@/lib/server/tour-agent";
import { draftFromRequest } from "@/lib/server/tour-requests";
import { ownedTourRequest } from "@/lib/server/user-tours";
import { recordEvent } from "@/lib/server/analytics";

export const maxDuration = 300;

/** Asks the tour agent for a new draft of a customer's tour. Nothing is saved until the customer saves. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, body, scene, error } = await ownedTourRequest(request, (await params).id, 10 * 1024 * 1024);
  if (error) return error;
  // The agent runs on the operator's own machine, one request at a time.
  if (!allowAttempt([[attemptKey("tour-agent", user.id), 30], ["tour-agent-all", 400]], 60 * 60 * 1000)) {
    return accountResponse({ error: "Your agent has had a lot of requests this hour. Edit by hand for now, or try again later." }, 429);
  }
  try {
    const result = await draftFromRequest(scene!, body, new URL(request.url).origin, false);
    void recordEvent("tour_agent", { userId: user.id, props: { stops: result.experience.stops.length } });
    return accountResponse({ ok: true, ...result });
  } catch (failure) {
    if (failure instanceof TourAgentError) return accountResponse({ error: failure.message }, 422);
    console.error("Tour agent failed for a customer tour:", failure);
    return accountResponse({ error: "The agent could not finish. Try again." }, 502);
  }
}
