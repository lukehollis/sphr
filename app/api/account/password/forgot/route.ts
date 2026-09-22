import { allowAttempt } from "@/lib/server/admin-store";
import { createUserToken, normalizeEmail, readUserByEmail } from "@/lib/server/accounts-store";
import { accountResponse, accountsEnabled, attemptKey, clientAddress, publicOrigin, readAccountBody } from "@/lib/server/accounts";
import { mailConfigured, sendMail } from "@/lib/server/mail";

export async function POST(request: Request) {
  if (!accountsEnabled() || !mailConfigured()) return accountResponse({ error: "Password reset is unavailable." }, 404);
  let body;
  try { body = await readAccountBody(request); } catch { return accountResponse({ error: "Invalid request." }, 400); }
  const email = normalizeEmail(body?.email);
  if (!email) return accountResponse({ error: "Enter a valid email address." }, 400);
  if (!allowAttempt([[attemptKey("forgot", clientAddress(request)), 10]], 60 * 60 * 1000)) return accountResponse({ error: "Too many requests. Try again later." }, 429);
  // The response never reveals whether an account exists.
  const user = readUserByEmail(email);
  if (user && allowAttempt([[attemptKey("forgot-email", email), 3]], 60 * 60 * 1000)) {
    const origin = publicOrigin(request);
    const token = createUserToken(user.id, "reset", 60 * 60 * 1000);
    // Not awaited: response time must not reveal whether the account exists.
    void sendMail(user.email, "Reset your password",
      `Choose a new password for your account at ${origin}:\n\n${origin}/account/reset?token=${token}\n\nThe link expires in one hour. If you did not ask for this, ignore this message.`)
      .catch(error => console.error("Unable to send password reset email:", error instanceof Error ? error.message : error));
  }
  return accountResponse({ ok: true });
}
