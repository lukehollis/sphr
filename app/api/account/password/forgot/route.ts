import { allowAttempt } from "@/lib/server/admin-store";
import { createUserToken, normalizeEmail, readUserByEmail } from "@/lib/server/accounts-store";
import { accountResponse, accountsEnabled, attemptKey, clientAddress, publicOrigin, readAccountBody } from "@/lib/server/accounts";
import { mailConfigured, sendMail } from "@/lib/server/mail";
import { passwordResetEmail } from "@/lib/server/emails";
import { siteBrand } from "@/lib/server/brand";
import { recordEvent } from "@/lib/server/analytics";

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
    void sendMail(user.email, passwordResetEmail(siteBrand(), origin, `${origin}/account/reset?token=${token}`))
      .catch(error => console.error("Unable to send password reset email:", error instanceof Error ? error.message : error));
  }
  await recordEvent("password_reset", { userId: user?.id });
  return accountResponse({ ok: true });
}
