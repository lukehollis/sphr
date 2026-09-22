import { allowAttempt } from "@/lib/server/admin-store";
import { AccountError, createPasswordUser } from "@/lib/server/accounts-store";
import { accountResponse, accountsEnabled, attemptKey, clientAddress, publicOrigin, readAccountBody, sendVerification, startUserSession } from "@/lib/server/accounts";
import { mailConfigured } from "@/lib/server/mail";

export async function POST(request: Request) {
  if (!accountsEnabled() || !mailConfigured()) return accountResponse({ error: "Email sign-up is unavailable." }, 404);
  let body;
  try { body = await readAccountBody(request); } catch { return accountResponse({ error: "Invalid request." }, 400); }
  if (!allowAttempt([[attemptKey("signup", clientAddress(request)), 10], ["account-signup", 500]], 60 * 60 * 1000)) {
    return accountResponse({ error: "Too many new accounts. Try again later." }, 429);
  }
  try {
    const user = await createPasswordUser(body?.email, body?.password, body?.name);
    await sendVerification(user, publicOrigin(request)).catch(error => console.error("Unable to send verification email:", error instanceof Error ? error.message : error));
    await startUserSession(user.id);
    return accountResponse({ ok: true });
  } catch (error) {
    if (error instanceof AccountError) return accountResponse({ error: error.message }, 400);
    throw error;
  }
}
