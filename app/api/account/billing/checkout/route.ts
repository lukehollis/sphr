import { AccountError, hostingStatuses, payableSpaceCount, readSubscription } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, publicOrigin } from "@/lib/server/accounts";
import { billingEnabled, startCheckout } from "@/lib/server/billing";
import { recordEvent } from "@/lib/server/analytics";

/**
 * Starts or resumes payment for waiting spaces, on the plan the customer chose (pay as you
 * go when none is named). A subscription that still exists in Stripe (for example, unpaid)
 * is repaired in the billing portal rather than duplicated.
 */
export async function POST(request: Request) {
  const { user, body, agent, error } = await accountRequest(request, 4096, { agents: true });
  if (error) return error;
  if (!billingEnabled()) return accountResponse({ error: "Billing is unavailable." }, 404);
  const subscription = readSubscription(user.id);
  if (subscription && hostingStatuses.has(subscription.status)) return accountResponse({ error: "Billing is already active." }, 409);
  if (!payableSpaceCount(user.id)) return accountResponse({ error: "Add a space first." }, 400);
  try {
    const next = await startCheckout(user, publicOrigin(request), body?.plan ?? undefined, agent);
    if ("url" in next) await recordEvent("checkout_started", { userId: user.id, props: { plan: next.plan, from: agent ? "agent" : "web" } });
    return accountResponse({ ok: true, ..."url" in next ? { url: next.url, plan: next.plan } : "portal" in next ? { url: next.portal } : { paid: true } });
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    console.error("Unable to start Checkout:", failure instanceof Error ? failure.message : failure);
    return accountResponse({ error: "Payment could not start. Try again." }, 502);
  }
}
