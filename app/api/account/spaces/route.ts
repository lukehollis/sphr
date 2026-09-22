import { allowAttempt } from "@/lib/server/admin-store";
import { AccountError, cleanText, createCustomerSpace, hostingStatuses, readCustomerSpace, readSubscription, removeCustomerSpaceRecord } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, attemptKey, publicOrigin } from "@/lib/server/accounts";
import { billingEnabled, startCheckout, syncQuantity } from "@/lib/server/billing";
import { describeSpace } from "@/lib/server/customer-spaces";

/** Adds a space. With billing, it joins the subscription or waits for Checkout. */
export async function POST(request: Request) {
  const { user, body, error } = await accountRequest(request);
  if (error) return error;
  if (!user.emailVerified) return accountResponse({ error: "Confirm your email address before adding a space." }, 403);
  const title = cleanText(body?.title, 200);
  if (!title) return accountResponse({ error: "Enter a title of 1–200 characters." }, 400);
  if (!allowAttempt([[attemptKey("space", user.id), 30]], 60 * 60 * 1000)) return accountResponse({ error: "Too many new spaces. Try again later." }, 429);
  try {
    const subscription = readSubscription(user.id);
    if (!billingEnabled()) return accountResponse({ ok: true, space: await describeSpace(createCustomerSpace(user.id, title, "draft")) });
    if (subscription && hostingStatuses.has(subscription.status)) {
      const space = createCustomerSpace(user.id, title, "draft");
      try { await syncQuantity(user.id); }
      catch (failure) {
        removeCustomerSpaceRecord(space.id);
        console.error("Unable to update the subscription quantity:", failure instanceof Error ? failure.message : failure);
        return accountResponse({ error: "Billing could not be updated. Try again." }, 502);
      }
      return accountResponse({ ok: true, space: await describeSpace(space) });
    }
    const space = createCustomerSpace(user.id, title, "unpaid");
    try {
      const next = await startCheckout(user, publicOrigin(request));
      const view = await describeSpace(readCustomerSpace(space.id)!);
      return accountResponse({ ok: true, space: view, ...("url" in next ? { checkout: next.url } : "portal" in next ? { portal: next.portal } : {}) });
    }
    catch (failure) {
      console.error("Unable to start Checkout:", failure instanceof Error ? failure.message : failure);
      return accountResponse({ ok: true, space: await describeSpace(space), error: "Payment could not start. Use Complete payment to try again." });
    }
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
