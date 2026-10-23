import { AccountError, cleanText, listUploads, parseSpaceOutput, readCustomerSpace, sameTeam, submitCustomerSpace } from "@/lib/server/accounts-store";
import { allowAttempt } from "@/lib/server/admin-store";
import { accountRequest, accountResponse, attemptKey, notifyOwner, publicOrigin, spaceHosted, submitsPerDay } from "@/lib/server/accounts";
import { describeSpace } from "@/lib/server/customer-spaces";
import { previewGateBody, previewMaxRuns, spacePreview } from "@/lib/server/previews";
import { announceJob } from "@/lib/server/job-signal";
import { filesReceivedEmail, linkReceivedEmail } from "@/lib/server/emails";
import { contactEmail, siteBrand } from "@/lib/server/brand";
import { filesSummary, notifyTeam } from "@/lib/server/team-notify";
import { recordEvent } from "@/lib/server/analytics";

/** Queues the uploaded files for processing, or the Matterport space the space was made from. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, body, agent, error } = await accountRequest(request, 8192, { agents: true });
  if (error) return error;
  const space = readCustomerSpace((await params).id);
  if (!space || !sameTeam(space.userId, user.id) || space.status === "deleted") return accountResponse({ error: "Space not found." }, 404);
  if (space.status === "unpaid") return accountResponse({ error: "Complete payment before submitting." }, 402);
  // A free preview is processed a few times at most, and only while its window is open.
  const preview = spaceHosted(space) ? null : spacePreview(space);
  if (!spaceHosted(space) && !preview) return accountResponse({ error: "Update your billing details to continue." }, 402);
  if (preview?.expired) return accountResponse(previewGateBody(space, "ended"), 402);
  if (preview && preview.runsLeft < 1) return accountResponse(previewGateBody(space, "limit", `A free preview is processed ${previewMaxRuns()} times at most.`), 402);
  // Each submission runs an agent; the limits survive deleting and recreating spaces.
  if (!allowAttempt([[attemptKey("submit", user.id), submitsPerDay], [attemptKey("submit-space", space.id), 5]], 24 * 60 * 60 * 1000)) {
    const contact = contactEmail();
    return accountResponse({ error: `This space has been submitted many times today. Try again tomorrow, or ${contact ? `write to ${contact}` : "contact support"}.` }, 429);
  }
  try {
    if (body?.output !== undefined && parseSpaceOutput(body.output) === undefined) {
      return accountResponse({ error: "Choose splat, tour or auto for the output." }, 400);
    }
    // A Matterport space becomes a tour unless the customer asks for something else.
    const output = parseSpaceOutput(body?.output);
    submitCustomerSpace(space.id, cleanText(body?.notes, 2000), space.source && output === undefined && !space.output ? "tour" : output);
    announceJob();
    const files = listUploads(space.id).filter(upload => upload.status === "complete");
    const source = space.source;
    await recordEvent("space_submitted", { userId: user.id, props: { files: files.length, bytes: files.reduce((total, upload) => total + upload.size, 0),
      from: agent ? "agent" : "web", ...(source ? { source: source.kind } : {}) } });
    void notifyTeam({ title: source ? "Matterport space submitted for processing" : "Space uploaded for processing", fields: [["Title", space.title], ["Account", user.email],
      ...(source ? [["Matterport", source.url] as [string, string]] : [["Files", filesSummary(files)] as [string, string],
        ["Kinds", [...new Set(files.map(file => file.name.split(".").pop()?.toLowerCase()).filter(Boolean))].slice(0, 8).join(", ")] as [string, string]]),
      ["Build as", readCustomerSpace(space.id)?.output ?? "auto"], ["From", agent ? "Their agent" : "The website"], ["Notes", cleanText(body?.notes, 300)]] });
    // Not awaited: the page should not wait on the mail server.
    void notifyOwner(user, source ? linkReceivedEmail(siteBrand(), publicOrigin(request), space, source.url)
      : filesReceivedEmail(siteBrand(), publicOrigin(request), space, { count: files.length, bytes: files.reduce((total, upload) => total + upload.size, 0) }));
    return accountResponse({ ok: true, space: await describeSpace(readCustomerSpace(space.id)!) });
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
