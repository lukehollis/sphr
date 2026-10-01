import { setScenePublic } from "@/lib/server/admin-store";
import { AccountError, claimJob, cleanText, finishJob, holdJob, readJob, readUser, releaseJob, setJobProgress } from "@/lib/server/accounts-store";
import { accountsEnabled, notifyOwner, publicOrigin } from "@/lib/server/accounts";
import { jobDetails, jobListing, releaseStaleJobs, workerAuthorized, workerResponse } from "@/lib/server/worker";
import { listingRevision, removePublishedScene } from "@/lib/server/published-assets";
import { spaceFailedEmail, spaceReadyEmail } from "@/lib/server/emails";
import { siteBrand } from "@/lib/server/brand";
import { notifyTeam } from "@/lib/server/team-notify";

type Params = { params: Promise<{ id: string }> };

async function readBody(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("Invalid content type");
  const text = await request.text();
  if (text.length > 16384) throw new Error("Body too large");
  return JSON.parse(text);
}

export async function GET(request: Request, { params }: Params) {
  if (!accountsEnabled() || !workerAuthorized(request)) return workerResponse({ error: "Unauthorized." }, 401);
  const job = readJob((await params).id);
  return job ? workerResponse({ job: jobDetails(job) }) : workerResponse({ error: "Job not found." }, 404);
}

/** Actions: claim, release, progress, hold (for an operator), complete (with the published listing), fail. */
export async function POST(request: Request, { params }: Params) {
  if (!accountsEnabled() || !workerAuthorized(request)) return workerResponse({ error: "Unauthorized." }, 401);
  let body;
  try { body = await readBody(request); } catch { return workerResponse({ error: "Invalid request." }, 400); }
  releaseStaleJobs();
  const job = readJob((await params).id);
  if (!job) return workerResponse({ error: "Job not found." }, 404);
  const message = cleanText(body?.message, 2000);
  try {
    if (body?.action === "claim") {
      const worker = cleanText(body.worker, 100) ?? "worker";
      const claimed = claimJob(job.id, worker);
      return claimed ? workerResponse({ job: jobDetails(claimed) }) : workerResponse({ error: "This job is not waiting." }, 409);
    }
    if (body?.action === "release") {
      return releaseJob(job.id) ? workerResponse({ ok: true }) : workerResponse({ error: "This job is not running." }, 409);
    }
    if (body?.action === "progress") {
      if (!message) return workerResponse({ error: "Describe the step." }, 400);
      return setJobProgress(job.id, message.slice(0, 300)) ? workerResponse({ ok: true }) : workerResponse({ error: "This job is not running." }, 409);
    }
    if (body?.action === "hold") {
      return holdJob(job.id, message) ? workerResponse({ job: jobDetails(readJob(job.id)!) }) : workerResponse({ error: "This job is not running." }, 409);
    }
    if (body?.action === "complete") {
      // The listing stays in the application database, out of the shared public catalog.
      let listing;
      try { listing = jobListing(job, body.scene); }
      catch (error) { return workerResponse({ error: `Invalid scene listing: ${error instanceof Error ? error.message : error}` }, 400); }
      // Stored as published and validated again whenever it is read.
      const result = finishJob(job.id, { ok: true, message, listing: body.scene });
      if (result.previousSceneId) setScenePublic(result.previousSceneId, false);
      // A reprocessed space keeps only its new revision.
      const revision = listingRevision(body.scene);
      if (result.job.status === "done" && revision) {
        void removePublishedScene(job.sceneId, revision).catch(error => console.error("Unable to remove earlier revisions:", error instanceof Error ? error.message : error));
      }
      if (result.job.status === "done") {
        void notifyTeam({ title: "Space ready", tone: "good", url: `${publicOrigin(request)}${listing.scenePath}`, fields: [["Title", result.space.title],
          ["Account", readUser(result.space.userId)?.email], ["Link", `${publicOrigin(request)}${listing.scenePath}`], ["Note", message]] });
        await notifyOwner(readUser(result.space.userId), spaceReadyEmail(siteBrand(), publicOrigin(request), result.space,
          { path: listing.scenePath, thumbnail: listing.thumbnail }));
      }
      return workerResponse({ job: jobDetails(result.job) });
    }
    if (body?.action === "fail") {
      if (!message) return workerResponse({ error: "Explain the failure for the customer." }, 400);
      const result = finishJob(job.id, { ok: false, message });
      if (result.job.status === "failed") {
        void notifyTeam({ title: "Space needs attention", tone: "bad", description: message,
          fields: [["Title", result.space.title], ["Account", readUser(result.space.userId)?.email]] });
        await notifyOwner(readUser(result.space.userId), spaceFailedEmail(siteBrand(), publicOrigin(request), result.space, message));
      }
      return workerResponse({ job: jobDetails(result.job) });
    }
    return workerResponse({ error: "Unknown action." }, 400);
  } catch (error) {
    if (error instanceof AccountError) return workerResponse({ error: error.message }, 409);
    throw error;
  }
}
