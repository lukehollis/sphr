import { allowAttempt } from "@/lib/server/admin-store";
import { checkUserPassword } from "@/lib/server/accounts-store";
import { accountResponse, accountsEnabled, attemptKey, clientAddress, readAccountBody, startUserSession } from "@/lib/server/accounts";

export async function POST(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  let body;
  try { body = await readAccountBody(request); } catch { return accountResponse({ error: "Invalid request." }, 400); }
  if (typeof body?.email !== "string" || typeof body?.password !== "string" || body.email.length > 254 || body.password.length > 256) {
    return accountResponse({ error: "Invalid email or password." }, 400);
  }
  if (!allowAttempt([[attemptKey("login", clientAddress(request)), 30], [attemptKey("login-email", body.email.trim()), 20]])) {
    return accountResponse({ error: "Too many sign-in attempts. Try again in 15 minutes." }, 429);
  }
  const user = await checkUserPassword(body.email, body.password);
  if (!user) return accountResponse({ error: "Invalid email or password." }, 401);
  await startUserSession(user.id);
  return accountResponse({ ok: true });
}
