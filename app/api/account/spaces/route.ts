import { allowAttempt } from "@/lib/server/admin-store";
import { AccountError, cleanText, createCustomerSpace, hostingStatuses, listCustomerSpaces, PlanLimitError, readCustomerSpace, readSubscription, readUser,
  removeCustomerSpaceRecord } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, accountsEnabled, attemptKey, publicOrigin, requestUser } from "@/lib/server/accounts";
import { billingEnabled, startCheckout, syncQuantity } from "@/lib/server/billing";
import { describeAccount, describeSpace } from "@/lib/server/customer-spaces";

/** The customer's spaces, newest first, and the account, for refreshing the page while spaces upload and process. */
export async function GET(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  const user = await requestUser(request, true);
  if (!user) return accountResponse({ error: "Sign in to continue." }, 401);
  return accountResponse({ spaces: await Promise.all(listCustomerSpaces(user.id).map(describeSpace)), account: describeAccount(readUser(user.id)!) });
}

/** Adds a space. With billing, it joins the subscription (within the plan's spaces) or waits for Checkout. */
export async function POST(request: Request) {
  const { user, body, agent, error } = await accountRequest(request, 4096, { agents: true });
  if (error) return error;
  if (!user.emailVerified) return accountResponse({ error: "Confirm your email address before adding a space." }, 403);
  const title = cleanText(body?.title, 200);
  if (!title) return accountResponse({ error: "Enter a title of 1–200 characters." }, 400);
  if (!allowAttempt([[attemptKey("space", user.id), 30]], 60 * 60 * 1000)) return accountResponse({ error: "Too many new spaces. Try again later." }, 429);
  try {
    const subscription = readSubscription(user.id);
    if (!billingEnabled()) return accountResponse({ ok: true, space: await describeSpace(createCustomerSpace(user.id, title, "draft")) });
    if (subscription && hostingStatuses.has(subscription.status)) {
      const space = createCustomerSpace(user.id, title, "draft", subscription.plan?.spaces ?? null);
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
      const next = await startCheckout(user, publicOrigin(request), undefined, agent);
      const view = await describeSpace(readCustomerSpace(space.id)!);
      return accountResponse({ ok: true, space: view, ...("url" in next ? { checkout: next.url, plan: next.plan } : "portal" in next ? { portal: next.portal } : {}) });
    }
    catch (failure) {
      console.error("Unable to start Checkout:", failure instanceof Error ? failure.message : failure);
      return accountResponse({ ok: true, space: await describeSpace(space), error: "Payment could not start. Use Complete payment to try again." });
    }
  } catch (failure) {
    // The page offers the plans that fit when the current plan is full.
    if (failure instanceof PlanLimitError) return accountResponse({ error: failure.message, planFull: true }, 402);
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
