import { allowAttempt } from "@/lib/server/admin-store";
import { AccountError, cleanText, createCustomerSpace, hostingStatuses, listCustomerSpaces, PlanLimitError, PreviewUsedError, readCustomerSpace, readSubscription,
  readUser, removeCustomerSpaceRecord } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, accountsEnabled, attemptKey, clientAddress, publicOrigin, requestUser } from "@/lib/server/accounts";
import { billingEnabled, startCheckout, syncQuantity } from "@/lib/server/billing";
import { describeAccount, describeSpace } from "@/lib/server/customer-spaces";
import { previewAddressLimit, previewRefusal, previewWindow, refusalText, type PreviewRefusal } from "@/lib/server/previews";
import { notifyTeam } from "@/lib/server/team-notify";
import { recordEvent } from "@/lib/server/analytics";
import { reportProblem } from "@/lib/server/error-report";

type Start = "unpaid" | "draft" | "preview";

function announceSpace(user: { id: string; email: string }, title: string, start: Start, agent: boolean) {
  void recordEvent("space_created", { userId: user.id, props: { from: agent ? "agent" : "web", first: start !== "draft", ...(start === "preview" ? { preview: true } : {}) } });
  void notifyTeam({ title: "Space created", fields: [["Title", title], ["Account", user.email],
    ["Status", start === "unpaid" ? "Waiting for first payment" : start === "preview" ? "Free preview, ready for files" : "Ready for files"],
    ["From", agent ? "Their agent" : "The website"]] });
}

/** What the page says it is about to upload, when it knows: the preview is only offered for a capture that fits. */
function declaredFiles(value: unknown) {
  const files = value as { count?: unknown; bytes?: unknown } | null | undefined;
  const count = files?.count, bytes = files?.bytes;
  return typeof count === "number" && typeof bytes === "number" && Number.isSafeInteger(count) && Number.isSafeInteger(bytes) && count >= 0 && bytes >= 0
    ? { count, bytes } : undefined;
}

/** The customer's spaces, newest first, and the account, for refreshing the page while spaces upload and process. */
export async function GET(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  const user = await requestUser(request, true);
  if (!user) return accountResponse({ error: "Sign in to continue." }, 401);
  return accountResponse({ spaces: await Promise.all(listCustomerSpaces(user.id).map(describeSpace)), account: describeAccount(readUser(user.id)!) });
}

/**
 * Adds a space. With billing, it joins the subscription (within the plan's spaces). Before hosting starts, the
 * account's first space is its free private preview, which opens for files at once; any other waits for Checkout.
 */
export async function POST(request: Request) {
  const { user, body, agent, error } = await accountRequest(request, 4096, { agents: true });
  if (error) return error;
  if (!user.emailVerified) return accountResponse({ error: "Confirm your email address before adding a space." }, 403);
  const title = cleanText(body?.title, 200);
  if (!title) return accountResponse({ error: "Enter a title of 1–200 characters." }, 400);
  if (!allowAttempt([[attemptKey("space", user.id), 30]], 60 * 60 * 1000)) return accountResponse({ error: "Too many new spaces. Try again later." }, 429);
  try {
    const subscription = readSubscription(user.id);
    if (!billingEnabled()) {
      const space = createCustomerSpace(user.id, title, "draft");
      announceSpace(user, title, "draft", agent);
      return accountResponse({ ok: true, space: await describeSpace(space) });
    }
    if (subscription && hostingStatuses.has(subscription.status)) {
      const space = createCustomerSpace(user.id, title, "draft", subscription.plan?.spaces ?? null);
      try { await syncQuantity(user.id); }
      catch (failure) {
        removeCustomerSpaceRecord(space.id);
        console.error("Unable to update the subscription quantity:", failure instanceof Error ? failure.message : failure);
        return accountResponse({ error: "Billing could not be updated. Try again." }, 502);
      }
      announceSpace(user, title, "draft", agent);
      return accountResponse({ ok: true, space: await describeSpace(space) });
    }
    // Nothing is paid for yet. The free preview comes first: the address limit is only spent when it is actually given.
    let declined: PreviewRefusal | undefined = previewRefusal(user.id, declaredFiles(body?.files));
    if (!declined && !allowAttempt([[attemptKey("preview-address", clientAddress(request)), previewAddressLimit()]], previewWindow)) declined = "busy";
    if (!declined) {
      try {
        const space = createCustomerSpace(user.id, title, "draft", null, true);
        announceSpace(user, title, "preview", agent);
        await recordEvent("preview_started", { userId: user.id, props: { from: agent ? "agent" : "web" } });
        return accountResponse({ ok: true, space: await describeSpace(space), preview: true });
      } catch (failure) {
        if (!(failure instanceof PreviewUsedError)) throw failure;
        declined = "used";
      }
    }
    // A second space after the preview is the ordinary case; only a capture that did not fit, or a day's budget gone, is worth counting.
    if (declined !== "used") await recordEvent("preview_declined", { userId: user.id, props: { reason: declined, from: agent ? "agent" : "web" } });
    const space = createCustomerSpace(user.id, title, "unpaid");
    announceSpace(user, title, "unpaid", agent);
    const why = { previewDeclined: declined, previewNote: refusalText[declined] };
    try {
      const next = await startCheckout(user, publicOrigin(request), undefined, agent);
      if ("url" in next) await recordEvent("checkout_started", { userId: user.id, props: { plan: next.plan, from: agent ? "agent" : "web" } });
      const view = await describeSpace(readCustomerSpace(space.id)!);
      return accountResponse({ ok: true, space: view, ...why, ...("url" in next ? { checkout: next.url, plan: next.plan } : "portal" in next ? { portal: next.portal } : {}) });
    }
    catch (failure) {
      console.error("Unable to start Checkout:", failure instanceof Error ? failure.message : failure);
      await recordEvent("checkout_failed", { userId: user.id });
      reportProblem("Payment could not start", failure instanceof Error ? failure.message : String(failure), [["Account", user.email]]);
      return accountResponse({ ok: true, space: await describeSpace(space), ...why, error: "Payment could not start. Try again in a moment." });
    }
  } catch (failure) {
    // The page offers the plans that fit when the current plan is full.
    if (failure instanceof PlanLimitError) return accountResponse({ error: failure.message, planFull: true }, 402);
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
