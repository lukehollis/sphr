import { readSceneEdits } from "./admin-store";
import { isScenePublic } from "./admin-store";
import { latestJob, listUploads, payableSpaceCount, readSubscription, type CustomerSpace, type User } from "./accounts-store";
import { billingEnabled } from "./billing";
import { spaceHosted } from "./accounts";
import { sourceUrl } from "./brand";
import { maxSpaceBytes } from "./uploads";
import { readSourceScenes } from "../scene-catalog";
import { editedListing } from "../scene-edits";

/** The customer's view of one space, with its published scene once processing has finished. */
export async function describeSpace(space: CustomerSpace) {
  const scene = space.sceneId ? (await readSourceScenes().catch(() => [])).find(item => item.sceneId === space.sceneId) : undefined;
  const listing = scene && editedListing(scene, readSceneEdits().get(scene.sceneId));
  const job = latestJob(space.id);
  return {
    id: space.id, title: listing?.title ?? space.title, status: space.status, notes: space.notes, output: space.output, message: space.message,
    created: space.created, updated: space.updated, hosted: spaceHosted(space),
    scene: listing ? { sceneId: listing.sceneId, path: listing.scenePath, thumbnail: listing.thumbnail, public: isScenePublic(listing.sceneId) } : null,
    job: job ? { status: job.status, created: job.created, started: job.started, finished: job.finished,
      progress: job.status === "running" || job.status === "held" ? job.progress : null } : null,
    uploads: listUploads(space.id).map(upload => ({ id: upload.id, name: upload.name, size: upload.size, status: upload.status }))
  };
}
export type SpaceView = Awaited<ReturnType<typeof describeSpace>>;

export function describeAccount(user: User) {
  const subscription = billingEnabled() ? readSubscription(user.id) : undefined;
  return {
    email: user.email, name: user.name, emailVerified: user.emailVerified, hasPassword: user.hasPassword, providers: user.providers,
    billing: billingEnabled(), maxSpaceBytes: maxSpaceBytes(), sourceUrl: sourceUrl() ?? null,
    /** Spaces that count toward a plan: every space not deleted. */
    spaceCount: payableSpaceCount(user.id),
    subscription: subscription ? { status: subscription.status, quantity: subscription.quantity, periodEnd: subscription.periodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd, plan: subscription.plan } : null
  };
}
export type AccountView = ReturnType<typeof describeAccount>;

export function editableStatus(space: CustomerSpace) {
  return ["draft", "failed", "ready"].includes(space.status);
}
