import { EditConflict } from "./admin-store";
import { TourAgentError } from "./tour-agent";

/**
 * Drafts that people's own agents ask for run in the background, because the tour agent
 * takes one to five minutes and most agents give up on a tool call after one. The
 * agent checks back with the tour, which carries the state of its latest draft. State
 * lives in this process: a restart forgets a draft under way, which then reads as idle.
 */
export type DraftState = { state: "drafting" | "done" | "failed"; started: string; finished?: string; reply?: string; error?: string };

const drafts = new Map<string, DraftState>();

export function draftState(tourId: string) {
  return drafts.get(tourId) ?? null;
}

/** What to tell the person when a draft fails: the agent's own words, or plain advice. */
function failureMessage(error: unknown) {
  if (error instanceof TourAgentError) return error.message;
  if (error instanceof EditConflict) return "The tour changed while the agent worked. Ask again.";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "Part of the space took too long to load, usually because the site was busy. Try again in a few minutes.";
  }
  return "The agent could not finish this draft. Try again, perhaps with a shorter request.";
}

export function startDraft(tourId: string, work: () => Promise<string>) {
  if (drafts.get(tourId)?.state === "drafting") return false;
  const entry: DraftState = { state: "drafting", started: new Date().toISOString() };
  drafts.set(tourId, entry);
  void work().then(
    (reply) => { drafts.set(tourId, { ...entry, state: "done", reply, finished: new Date().toISOString() }); },
    (error) => {
      if (!(error instanceof TourAgentError) && !(error instanceof EditConflict)) console.error("A background tour draft failed:", error);
      drafts.set(tourId, { ...entry, state: "failed", error: failureMessage(error), finished: new Date().toISOString() });
    }
  );
  return true;
}
