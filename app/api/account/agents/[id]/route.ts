import { revokeAgentToken } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse } from "@/lib/server/accounts";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await accountRequest(request);
  if (error) return error;
  return revokeAgentToken(user.id, (await params).id) ? accountResponse({ ok: true }) : accountResponse({ error: "Agent not found." }, 404);
}
