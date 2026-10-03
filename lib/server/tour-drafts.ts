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

export function startDraft(tourId: string, work: () => Promise<string>) {
  if (drafts.get(tourId)?.state === "drafting") return false;
  const entry: DraftState = { state: "drafting", started: new Date().toISOString() };
  drafts.set(tourId, entry);
  void work().then(
    (reply) => { drafts.set(tourId, { ...entry, state: "done", reply, finished: new Date().toISOString() }); },
    (error) => { drafts.set(tourId, { ...entry, state: "failed", error: error instanceof Error ? error.message : "The agent could not finish.", finished: new Date().toISOString() }); }
  );
  return true;
}
