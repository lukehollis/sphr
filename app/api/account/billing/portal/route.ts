import { accountRequest, accountResponse, publicOrigin } from "@/lib/server/accounts";
import { billingEnabled, portalUrl } from "@/lib/server/billing";

/** Stripe's hosted portal: payment methods, invoices and cancellation. */
export async function POST(request: Request) {
  const { user, error } = await accountRequest(request);
  if (error) return error;
  if (!billingEnabled()) return accountResponse({ error: "Billing is unavailable." }, 404);
  try { return accountResponse({ ok: true, url: await portalUrl(user, publicOrigin(request)) }); }
  catch (failure) {
    console.error("Unable to open the billing portal:", failure instanceof Error ? failure.message : failure);
    return accountResponse({ error: "Billing could not open. Try again." }, 502);
  }
}
