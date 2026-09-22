import { accountResponse, accountsEnabled, endUserSession, sameOrigin } from "@/lib/server/accounts";

export async function POST(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  if (!sameOrigin(request)) return accountResponse({ error: "Invalid request." }, 403);
  await endUserSession();
  return accountResponse({ ok: true });
}
