import { AccountError, cleanText, listUploads, readCustomerSpace, submitCustomerSpace } from "@/lib/server/accounts-store";
import { allowAttempt } from "@/lib/server/admin-store";
import { accountRequest, accountResponse, attemptKey, notifyOwner, publicOrigin, spaceHosted } from "@/lib/server/accounts";
import { describeSpace } from "@/lib/server/customer-spaces";
import { announceJob } from "@/lib/server/job-signal";
import { filesReceivedEmail } from "@/lib/server/emails";
import { siteBrand } from "@/lib/server/brand";
import { filesSummary, notifyTeam } from "@/lib/server/team-notify";
import { recordEvent } from "@/lib/server/analytics";

/** Queues the uploaded files for processing. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, body, agent, error } = await accountRequest(request, 8192, { agents: true });
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
    const files = listUploads(space.id).filter(upload => upload.status === "complete");
    await recordEvent("space_submitted", { userId: user.id, props: { files: files.length, bytes: files.reduce((total, upload) => total + upload.size, 0),
      from: agent ? "agent" : "web" } });
    void notifyTeam({ title: "Space uploaded for processing", fields: [["Title", space.title], ["Account", user.email], ["Files", filesSummary(files)],
      ["Kinds", [...new Set(files.map(file => file.name.split(".").pop()?.toLowerCase()).filter(Boolean))].slice(0, 8).join(", ")],
      ["From", agent ? "Their agent" : "The website"], ["Notes", cleanText(body?.notes, 300)]] });
    // Not awaited: the page should not wait on the mail server.
    void notifyOwner(user, filesReceivedEmail(siteBrand(), publicOrigin(request), space,
      { count: files.length, bytes: files.reduce((total, upload) => total + upload.size, 0) }));
    return accountResponse({ ok: true, space: await describeSpace(readCustomerSpace(space.id)!) });
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
