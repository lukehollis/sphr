import { allowAttempt } from "@/lib/server/admin-store";
import { AccountError, convertToPreview, PreviewUsedError, readCustomerSpace, sameTeam } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, attemptKey, clientAddress } from "@/lib/server/accounts";
import { billingEnabled } from "@/lib/server/billing";
import { describeSpace } from "@/lib/server/customer-spaces";
import { previewAddressLimit, previewRefusal, previewWindow, refusalText } from "@/lib/server/previews";
import { recordEvent } from "@/lib/server/analytics";

/**
 * Makes a space that waits for payment the account's free preview, so files can upload now and payment
 * comes when the result is ready. For spaces made before previews existed, and for the day a busy preview budget refused one.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, agent, error } = await accountRequest(request, 4096, { agents: true });
  if (error) return error;
  const space = readCustomerSpace((await params).id);
  if (!space || !sameTeam(space.userId, user.id) || space.status === "deleted") return accountResponse({ error: "Space not found." }, 404);
  if (!billingEnabled() || space.status !== "unpaid") return accountResponse({ error: "This space is not waiting for payment." }, 409);
  let declined = previewRefusal(user.id);
  if (!declined && !allowAttempt([[attemptKey("preview-address", clientAddress(request)), previewAddressLimit()]], previewWindow)) declined = "busy";
  if (declined) return accountResponse({ error: refusalText[declined], reason: declined }, declined === "busy" ? 429 : 409);
  try {
    const started = convertToPreview(space.id, user.id);
    await recordEvent("preview_started", { userId: user.id, props: { from: agent ? "agent" : "web", converted: true } });
    return accountResponse({ ok: true, space: await describeSpace(started), preview: true });
  } catch (failure) {
    if (failure instanceof PreviewUsedError) return accountResponse({ error: refusalText.used, reason: "used" }, 409);
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 409);
    throw failure;
  }
}
