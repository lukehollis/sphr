import { listJobs } from "./accounts-store";
import { notifyTeam } from "./team-notify";

// Processing problems no customer reports: a worker that cannot start its agents, and no worker at all.
// Each worker posts its own check every few minutes (/api/worker/health) and polls for jobs; a job that
// waits while no worker polls is announced too. In memory: one application process serves the workers.
// (2026-10-19: the agent images vanished from the only worker and nobody knew for sixteen days.)

const minute = 60000;
const state = { started: Date.now(), seen: 0, idleAnnounced: -Infinity, problems: new Map<string, { key: string; announced: number }>() };

/** A worker asked for jobs. */
export function workerSeen(now = Date.now()) {
  state.seen = now;
}

/** What a worker's check means for the team: a problem, new or still standing after six hours; its end; or nothing. */
export function healthNotice(previous: { key: string; announced: number } | undefined, key: string | null, now: number) {
  if (key === null) return previous ? "resumed" : null;
  return !previous || previous.key !== key || now - previous.announced >= 360 * minute ? "paused" : null;
}

/** Records a worker's check (`problem` null when it can start agents) and tells the team when that changes. */
export function reportWorkerHealth(worker: string, problem: string | null, now = Date.now()) {
  state.seen = now;
  const previous = state.problems.get(worker);
  // Counts in the problem (free disk space, minutes) change at every check; the problem itself does not.
  const key = problem === null ? null : problem.replace(/\d+(?:\.\d+)?/g, "#");
  const notice = healthNotice(previous, key, now);
  if (key === null) state.problems.delete(worker);
  else if (notice) state.problems.set(worker, { key, announced: now });
  if (notice === "paused") {
    void notifyTeam({ title: "Processing paused", tone: "bad", description: problem ?? undefined,
      fields: [["Worker", worker], ["Jobs waiting", listJobs(["queued"]).length]] });
  } else if (notice === "resumed") {
    void notifyTeam({ title: "Processing resumed", tone: "good", fields: [["Worker", worker]] });
  }
  return notice;
}

/** Whether to say no worker is taking jobs: one has waited 15 minutes while none polled for 10 (at most hourly). */
export function idleNotice(now: number, { started, seen, idleAnnounced }: { started: number; seen: number; idleAnnounced: number }, oldestQueued?: string) {
  if (!oldestQueued || now - started < 10 * minute) return false;
  return now - Date.parse(oldestQueued) >= 15 * minute && now - seen >= 10 * minute && now - idleAnnounced >= 60 * minute;
}

let watching: ReturnType<typeof setInterval> | undefined;

/** Checks every five minutes for jobs that wait while no worker asks for them. */
export function watchWorkers() {
  if (watching) return;
  watching = setInterval(async () => {
    try {
      const { accountsEnabled } = await import("./accounts");
      if (!accountsEnabled()) return;
      const now = Date.now();
      const waiting = listJobs(["queued"]);
      const oldest = waiting.map(job => job.created).sort()[0];
      if (!idleNotice(now, state, oldest)) return;
      state.idleAnnounced = now;
      const quiet = state.seen ? `for ${Math.round((now - state.seen) / minute)} minutes` : "since the application started";
      void notifyTeam({ title: "No worker is taking jobs", tone: "bad",
        description: `${waiting.length} ${waiting.length === 1 ? "job is" : "jobs are"} waiting, the oldest since ${oldest}. No worker has asked for jobs ${quiet}.`,
        fields: [["Jobs waiting", waiting.length]] });
    } catch (error) {
      console.error("Unable to check the processing workers:", error instanceof Error ? error.message : error);
    }
  }, 5 * minute);
  watching.unref?.();
}
