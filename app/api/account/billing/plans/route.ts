import { accountResponse, accountsEnabled, requestUser } from "@/lib/server/accounts";
import { readPlans } from "@/lib/server/billing";
import { describeAccount } from "@/lib/server/customer-spaces";

/** The ways to pay for hosting, for someone about to add a space (in the browser or through their agent). */
export async function GET(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  const user = await requestUser(request, true);
  if (!user) return accountResponse({ error: "Sign in to continue." }, 401);
  return accountResponse({ plans: await readPlans(), account: describeAccount(user) });
}
