import { allowAttempt } from "@/lib/server/admin-store";
import { approveAgentLink, denyAgentLink, listAgentTokens, readAgentLink } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, accountsEnabled, attemptKey, currentUser } from "@/lib/server/accounts";
import { notifyTeam } from "@/lib/server/team-notify";
import { recordEvent } from "@/lib/server/analytics";

/** Agents linked to the signed-in account. */
export async function GET() {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  const user = await currentUser();
  if (!user) return accountResponse({ error: "Sign in to continue." }, 401);
  return accountResponse({ agents: listAgentTokens(user.id) });
}

/** Approves or declines an agent's code. Only the browser session can do this, never another agent. */
export async function POST(request: Request) {
  const { user, body, error } = await accountRequest(request);
  if (error) return error;
  if (!allowAttempt([[attemptKey("agent-approve", user.id), 30]], 60 * 60 * 1000)) return accountResponse({ error: "Too many attempts. Try again later." }, 429);
  if (body?.approve === false) { denyAgentLink(body?.code); return accountResponse({ ok: true }); }
  const link = readAgentLink(body?.code);
  if (!approveAgentLink(body?.code, user.id)) return accountResponse({ error: "This code has expired or was already used. Ask your agent to start again." }, 410);
  await recordEvent("agent_linked", { userId: user.id, props: { client: link?.client ?? "unknown" } });
  void notifyTeam({ title: "Agent linked", fields: [["Agent", link?.client], ["Account", user.email]] });
  return accountResponse({ ok: true });
}
