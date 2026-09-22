import { consumeUserToken, resetUserPassword, validPassword } from "@/lib/server/accounts-store";
import { accountResponse, accountsEnabled, readAccountBody, startUserSession } from "@/lib/server/accounts";

export async function POST(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  let body;
  try { body = await readAccountBody(request); } catch { return accountResponse({ error: "Invalid request." }, 400); }
  if (!validPassword(body?.password)) return accountResponse({ error: "Use a password with 8–256 characters." }, 400);
  const userId = consumeUserToken(body?.token, "reset");
  if (!userId) return accountResponse({ error: "This link has expired or was already used. Request a new one." }, 400);
  await resetUserPassword(userId, body.password);
  await startUserSession(userId);
  return accountResponse({ ok: true });
}
