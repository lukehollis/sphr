import { AccountError, joinTeamByCode, matchingDomainTeam, userTeam } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse } from "@/lib/server/accounts";
import { billingEnabled, syncQuantity } from "@/lib/server/billing";
import { describeAccount } from "@/lib/server/customer-spaces";
import { notifyTeam } from "@/lib/server/team-notify";
import { recordEvent } from "@/lib/server/analytics";

export async function POST(request: Request) {
  const { user, body, error } = await accountRequest(request, 4096, { agents: true });
  if (error) return error;
  try {
    const code = typeof body?.code === "string" && body.code.trim()
      ? body.code
      : (user.emailVerified ? matchingDomainTeam(user.email)?.joinCode : undefined);
    if (!code) return accountResponse({ error: "Enter a team invite code or link." }, 400);
    const team = joinTeamByCode(user.id, code);
    if (billingEnabled()) {
      await syncQuantity(user.id).catch(failure => console.error("Unable to update the subscription quantity:", failure instanceof Error ? failure.message : failure));
    }
    const membership = userTeam(user.id);
    await recordEvent("team_joined", { userId: user.id, props: { teamId: team.id } });
    void notifyTeam({ title: "Team member joined", fields: [["Team", team.name], ["Account", user.email], ["Role", membership?.role ?? "member"]] });
    return accountResponse({
      ok: true,
      account: describeAccount(user),
      team,
      role: membership?.role ?? "member",
    });
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
