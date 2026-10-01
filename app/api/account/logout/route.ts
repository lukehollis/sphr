import { accountResponse, accountsEnabled, currentUser, endUserSession, sameOrigin } from "@/lib/server/accounts";
import { recordEvent } from "@/lib/server/analytics";

export async function POST(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  if (!sameOrigin(request)) return accountResponse({ error: "Invalid request." }, 403);
  await recordEvent("logout", { userId: (await currentUser())?.id });
  await endUserSession();
  return accountResponse({ ok: true });
}
