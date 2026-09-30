import { claimAgentLink, deleteAgentToken } from "@/lib/server/accounts-store";
import { accountResponse, accountsEnabled, bearerToken, readAccountBody } from "@/lib/server/accounts";

/** The agent's poll: pending until the person approves, then the token, once. */
export async function POST(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  let body;
  try { body = await readAccountBody(request, 1024, false); } catch { return accountResponse({ error: "Invalid request." }, 400); }
  const result = claimAgentLink(body?.code);
  if (result.status === "expired") return accountResponse({ status: "expired", error: "This link has expired. Start again." }, 410);
  if (result.status === "pending") return accountResponse({ status: "pending" });
  return accountResponse({ status: "approved", token: result.token, email: result.user.email, emailVerified: result.user.emailVerified });
}

/** Unlinks the agent that sends this token. */
export async function DELETE(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  return deleteAgentToken(bearerToken(request)) ? accountResponse({ ok: true }) : accountResponse({ error: "This agent is not linked." }, 401);
}
