import { AccountError, cleanText, readCustomerSpace, submitCustomerSpace } from "@/lib/server/accounts-store";
import { allowAttempt } from "@/lib/server/admin-store";
import { accountRequest, accountResponse, attemptKey, spaceHosted } from "@/lib/server/accounts";
import { describeSpace } from "@/lib/server/customer-spaces";
import { announceJob } from "@/lib/server/job-signal";

/** Queues the uploaded files for processing. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, body, error } = await accountRequest(request, 8192);
  if (error) return error;
  const space = readCustomerSpace((await params).id);
  if (!space || space.userId !== user.id || space.status === "deleted") return accountResponse({ error: "Space not found." }, 404);
  if (space.status === "unpaid") return accountResponse({ error: "Complete payment before submitting." }, 402);
  if (!spaceHosted(space)) return accountResponse({ error: "Update your billing details to continue." }, 402);
  // Each submission runs an agent; the limits survive deleting and recreating spaces.
  if (!allowAttempt([[attemptKey("submit", user.id), 20], [attemptKey("submit-space", space.id), 5]], 24 * 60 * 60 * 1000)) {
    return accountResponse({ error: "This space has been submitted many times today. Try again tomorrow, or contact support." }, 429);
  }
  try {
    submitCustomerSpace(space.id, cleanText(body?.notes, 2000));
    announceJob();
    return accountResponse({ ok: true, space: await describeSpace(readCustomerSpace(space.id)!) });
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
