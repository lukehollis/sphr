import { AccountError, createTeam, listTeams, matchingDomainTeam, provisionEnterpriseTeam, removeTeamMember, updateTeam, userTeam } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, accountsEnabled, requestUser } from "@/lib/server/accounts";
import { isAdmin } from "@/lib/server/auth";
import { describeAccount } from "@/lib/server/customer-spaces";
import { operatorAccount } from "@/lib/server/profiles";
import { notifyTeam } from "@/lib/server/team-notify";
import { recordEvent } from "@/lib/server/analytics";

async function canProvision(userId: string) {
  return operatorAccount() === userId || await isAdmin();
}

export async function GET(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  const user = await requestUser(request, true);
  if (!user) return accountResponse({ error: "Sign in to continue." }, 401);
  const membership = userTeam(user.id);
  const operator = await canProvision(user.id);
  const matching = !membership && user.emailVerified ? matchingDomainTeam(user.email) ?? null : null;
  return accountResponse({
    account: describeAccount(user),
    team: membership?.team ?? null,
    role: membership?.role ?? null,
    matchingTeam: matching ? { id: matching.id, name: matching.name, joinCode: matching.joinCode, joinDomain: matching.joinDomain } : null,
    operator,
    ...(operator ? { allTeams: listTeams() } : {}),
  });
}

export async function POST(request: Request) {
  const { user, body, error } = await accountRequest(request, 4096, { agents: true });
  if (error) return error;
  const operator = await canProvision(user.id);
  try {
    if (body?.provision) {
      if (!operator) return accountResponse({ error: "Only the operator can provision enterprise teams." }, 403);
      const provisioned = provisionEnterpriseTeam({
        name: body.name,
        ownerEmail: body.ownerEmail,
        joinDomain: body.joinDomain,
        planName: body.planName,
        planSpaces: body.planSpaces,
      });
      const membership = userTeam(user.id);
      return accountResponse({
        ok: true,
        provisioned,
        account: describeAccount(user),
        team: membership?.team ?? null,
        role: membership?.role ?? null,
        allTeams: listTeams(),
      }, 201);
    }
    const team = createTeam(user.id, { name: body?.name, joinDomain: body?.joinDomain });
    await recordEvent("team_created", { userId: user.id, props: { teamId: team.id, domain: team.joinDomain ?? "" } });
    void notifyTeam({ title: "Team created", fields: [["Team", team.name], ["Owner", user.email], ["Domain", team.joinDomain ? `@${team.joinDomain}` : "-"]] });
    return accountResponse({
      ok: true,
      account: describeAccount(user),
      team,
      role: "owner" as const,
      ...(operator ? { allTeams: listTeams() } : {}),
    }, 201);
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}

export async function PATCH(request: Request) {
  const { user, body, error } = await accountRequest(request, 4096, { agents: true });
  if (error) return error;
  const operator = await canProvision(user.id);
  const membership = userTeam(user.id);
  const teamId = typeof body?.teamId === "string" ? body.teamId : membership?.team.id;
  if (!teamId) return accountResponse({ error: "Team not found." }, 404);
  try {
    const updated = updateTeam(teamId, user.id, {
      name: body?.name,
      joinDomain: body?.joinDomain,
      regenerateJoinCode: Boolean(body?.regenerateJoinCode),
      planName: body?.planName,
      planSpaces: body?.planSpaces,
    }, operator);
    const nextMembership = userTeam(user.id);
    return accountResponse({
      ok: true,
      account: describeAccount(user),
      team: nextMembership?.team ?? updated,
      role: nextMembership?.role ?? null,
      ...(operator ? { allTeams: listTeams() } : {}),
    });
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}

export async function DELETE(request: Request) {
  const { user, error } = await accountRequest(request, 4096);
  if (error) return error;
  const membership = userTeam(user.id);
  if (!membership) return accountResponse({ error: "You are not on a team." }, 404);
  const operator = await canProvision(user.id);
  try {
    removeTeamMember(membership.team.id, user.id, user.id, operator);
    return accountResponse({
      ok: true,
      account: describeAccount(user),
      team: null,
      role: null,
      ...(operator ? { allTeams: listTeams() } : {}),
    });
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
