import { createHash, timingSafeEqual } from "node:crypto";
import { expireJobLeases, listUploads, readCustomerSpace, readUser, type CustomerSpace, type Job } from "./accounts-store";
import { notifyOwner } from "./accounts";
import { saveEvent } from "./analytics-store";
import { contactEmail, siteBrand } from "./brand";
import { spaceFailedEmail } from "./emails";
import { notifyTeam } from "./team-notify";
import { uploadBucket } from "./uploads";
import { parseSceneCatalog } from "../scene-catalog-data";

/** Customer scenes may be published to their own asset host, one that does not allow listing. */
export const customerAssetBase = () => (process.env.SPHR_CUSTOMER_ASSET_BASE_URL || process.env.SPHR_ASSET_BASE_URL || "").trim();

/** Validates a published listing for this job: its reserved scene ID, storage slug and asset URLs. */
export function jobListing(job: Job, value: unknown) {
  const [listing] = parseSceneCatalog(JSON.stringify({ spaces: [value] }), customerAssetBase());
  if (listing.sceneId !== job.sceneId || listing.slug !== `customer-${job.spaceId}`) throw new Error("The listing does not belong to this job.");
  return listing;
}

/**
 * Jobs whose worker went quiet return to the queue after this many hours. A job that has used
 * every attempt waits for an operator, and its owner is told, as the processing email promised.
 * Not awaited: the worker asking for jobs never waits on the mail server.
 */
export function releaseStaleJobs(origin: string) {
  for (const { job, space } of expireJobLeases(Number(process.env.SPHR_JOB_LEASE_HOURS ?? 12))) {
    void announceStalled(job, space, origin).catch(error => console.error(`Unable to announce stalled job ${job.id}:`, error instanceof Error ? error.message : error));
  }
}

async function announceStalled(job: Job, space: CustomerSpace, origin: string) {
  const owner = readUser(space.userId);
  saveEvent("space_failed", { userId: space.userId, props: { stalled: true } });
  void notifyTeam({ title: "Space held for review", tone: "warn", description: job.message ?? undefined,
    fields: [["Title", space.title], ["Account", owner?.email]] });
  await notifyOwner(owner, spaceFailedEmail(siteBrand(), origin, space, space.message ?? "", contactEmail()));
}

/** Processing workers authenticate with one shared bearer token of at least 32 characters. */
export function workerAuthorized(request: Request) {
  const expected = process.env.SPHR_WORKER_TOKEN?.trim();
  const supplied = request.headers.get("authorization")?.match(/^Bearer (\S{1,512})$/)?.[1];
  if (!expected || expected.length < 32 || !supplied) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

export function workerResponse(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

/** Everything a worker needs to process one job. Customer text is untrusted input. */
export function jobDetails(job: Job) {
  const space = readCustomerSpace(job.spaceId)!;
  const bucket = uploadBucket();
  return {
    id: job.id, status: job.status, sceneId: job.sceneId, slug: `customer-${space.id}`, created: job.created, started: job.started,
    space: { id: space.id, title: space.title, notes: space.notes, output: space.output ?? "auto", reprocessing: Boolean(space.sceneId) },
    uploads: listUploads(space.id).filter(upload => upload.status === "complete").map(upload => ({
      id: upload.id, name: upload.name, size: upload.size, type: upload.type,
      source: bucket ? { gcs: `gs://${bucket}/${upload.object}` } : { url: `/api/worker/uploads/${upload.id}` }
    }))
  };
}
