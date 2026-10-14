import { AccountError, billingUserId, removeTeamMember, setTeamOwner, userTeam } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse } from "@/lib/server/accounts";
import { isAdmin } from "@/lib/server/auth";
import { billingEnabled, syncQuantity } from "@/lib/server/billing";
import { describeAccount } from "@/lib/server/customer-spaces";
import { operatorAccount } from "@/lib/server/profiles";

type Params = { params: Promise<{ userId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const { user, body, error } = await accountRequest(request, 4096);
  if (error) return error;
  const { userId: targetUserId } = await params;
  const operator = operatorAccount() === user.id || await isAdmin();
  const membership = userTeam(user.id);
  const teamId = typeof body?.teamId === "string" ? body.teamId : membership?.team.id;
  if (!teamId) return accountResponse({ error: "Team not found." }, 404);
  if (body?.role !== "owner") return accountResponse({ error: "Choose a valid role." }, 400);
  try {
    const team = setTeamOwner(teamId, user.id, targetUserId, operator);
    const nextMembership = userTeam(user.id);
    return accountResponse({
      ok: true,
      account: describeAccount(user),
      team,
      role: nextMembership?.role ?? null,
    });
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { user, body, error } = await accountRequest(request, 4096);
  if (error) return error;
  const { userId: targetUserId } = await params;
  const operator = operatorAccount() === user.id || await isAdmin();
  const membership = userTeam(user.id);
  const teamId = typeof body?.teamId === "string" ? body.teamId : membership?.team.id;
  if (!teamId) return accountResponse({ error: "Team not found." }, 404);
  const billingId = billingUserId(user.id);
  try {
    const team = removeTeamMember(teamId, user.id, targetUserId, operator);
    if (billingEnabled()) {
      await syncQuantity(billingId).catch(failure => console.error("Unable to update the subscription quantity:", failure instanceof Error ? failure.message : failure));
    }
    const nextMembership = userTeam(user.id);
    return accountResponse({
      ok: true,
      account: describeAccount(user),
      team,
      role: nextMembership?.role ?? null,
    });
  } catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
