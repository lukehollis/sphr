import { AccountError, readUser } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse } from "@/lib/server/accounts";
import { billingEnabled, changePlan } from "@/lib/server/billing";
import { describeAccount } from "@/lib/server/customer-spaces";

/** Moves a hosting subscription to another plan; the next invoice is prorated. */
export async function POST(request: Request) {
  const { user, body, error } = await accountRequest(request);
  if (error) return error;
  if (!billingEnabled()) return accountResponse({ error: "Billing is unavailable." }, 404);
  try {
    await changePlan(user, body?.plan);
    return accountResponse({ ok: true, account: describeAccount(readUser(user.id)!) });
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    console.error("Unable to change plans:", failure instanceof Error ? failure.message : failure);
    return accountResponse({ error: "The plan could not change. Try again." }, 502);
  }
}
