import { allowAttempt } from "@/lib/server/admin-store";
import { cleanText, createAgentLink } from "@/lib/server/accounts-store";
import { accountResponse, accountsEnabled, attemptKey, clientAddress, publicOrigin, readAccountBody } from "@/lib/server/accounts";

/**
 * An agent starts linking to an account. It opens `url` in the person's browser, where they
 * sign in and approve the code, and polls `/api/agent/token` with `code` until then.
 */
export async function POST(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  let body;
  try { body = await readAccountBody(request, 1024, false); } catch { return accountResponse({ error: "Invalid request." }, 400); }
  if (!allowAttempt([[attemptKey("agent-link", clientAddress(request)), 30]], 60 * 60 * 1000)) {
    return accountResponse({ error: "Too many link requests. Try again later." }, 429);
  }
  const client = cleanText(body?.client, 80) ?? "An agent";
  const link = createAgentLink(client);
  const url = `${publicOrigin(request)}/account/connect/${link.userCode}`;
  return accountResponse({ ok: true, code: link.code, userCode: link.userCode, url, interval: 3, expiresIn: link.expiresIn });
}
