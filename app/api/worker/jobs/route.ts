import { listJobs, type JobStatus } from "@/lib/server/accounts-store";
import { accountsEnabled } from "@/lib/server/accounts";
import { jobDetails, releaseStaleJobs, workerAuthorized, workerResponse } from "@/lib/server/worker";
import { waitForJob } from "@/lib/server/job-signal";

export const dynamic = "force-dynamic";
const statuses: JobStatus[] = ["queued", "running", "held", "done", "failed", "canceled"];

export async function GET(request: Request) {
  if (!accountsEnabled() || !workerAuthorized(request)) return workerResponse({ error: "Unauthorized." }, 401);
  const requested = (new URL(request.url).searchParams.get("status") ?? "queued").split(",");
  if (!requested.every(status => statuses.includes(status as JobStatus))) return workerResponse({ error: "Unknown status." }, 400);
  releaseStaleJobs();
  // ?wait=N holds the request up to N seconds (at most 50) until a job is queued, so workers start at once.
  const wait = Math.min(50, Math.max(0, Number(new URL(request.url).searchParams.get("wait") ?? 0) || 0));
  let jobs = listJobs(requested as JobStatus[]);
  if (!jobs.length && wait && requested.includes("queued")) {
    await waitForJob(wait * 1000, request.signal);
    jobs = listJobs(requested as JobStatus[]);
  }
  return workerResponse({ jobs: jobs.map(jobDetails) });
}
