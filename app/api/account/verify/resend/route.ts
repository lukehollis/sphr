import { allowAttempt } from "@/lib/server/admin-store";
import { accountRequest, accountResponse, attemptKey, publicOrigin, sendVerification } from "@/lib/server/accounts";
import { recordEvent } from "@/lib/server/analytics";

/** Sends a new confirmation link to the signed-in customer. */
export async function POST(request: Request) {
  const { user, error } = await accountRequest(request);
  if (error) return error;
  if (user.emailVerified) return accountResponse({ ok: true });
  if (!allowAttempt([[attemptKey("verify", user.id), 3]], 60 * 60 * 1000)) return accountResponse({ error: "A link was sent recently. Check your inbox or try again later." }, 429);
  try { await sendVerification(user, publicOrigin(request)); }
  catch { return accountResponse({ error: "The email could not be sent. Try again later." }, 502); }
  await recordEvent("verify_sent", { userId: user.id, props: { resend: true } });
  return accountResponse({ ok: true });
}
