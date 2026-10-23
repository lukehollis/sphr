import { sameTeam } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, accountsEnabled, requestUser } from "@/lib/server/accounts";
import { advanceImports, checkImports, describeImport, freshenImports, readImport, skipItem, stopImport } from "@/lib/server/imports";

type Params = { params: Promise<{ id: string }> };

/** A list and every link on it, for its page while the spaces come over. Asking moves the queue too. */
export async function GET(request: Request, { params }: Params) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  const user = await requestUser(request, true);
  if (!user) return accountResponse({ error: "Sign in to continue." }, 401);
  const list = readImport((await params).id);
  if (!list || !sameTeam(list.userId, user.id)) return accountResponse({ error: "List not found." }, 404);
  if (!list.finished) {
    void checkImports().catch(() => undefined);
    await freshenImports(list.userId);
  }
  return accountResponse({ import: describeImport(readImport(list.id)!) });
}

/** Takes one waiting link off the list (`skip` with its `item`), or every waiting link (`stop`). Spaces already made stay. */
export async function POST(request: Request, { params }: Params) {
  const { user, body, error } = await accountRequest(request, 4096, { agents: true });
  if (error) return error;
  const list = readImport((await params).id);
  if (!list || !sameTeam(list.userId, user.id)) return accountResponse({ error: "List not found." }, 404);
  if (body?.action === "skip") {
    if (!skipItem(list.id, body.item)) return accountResponse({ error: "This space is no longer waiting." }, 409);
  } else if (body?.action === "stop") {
    stopImport(list.id);
  } else return accountResponse({ error: "Unknown action." }, 400);
  await advanceImports(list.userId);
  return accountResponse({ ok: true, import: describeImport(readImport(list.id)!) });
}
