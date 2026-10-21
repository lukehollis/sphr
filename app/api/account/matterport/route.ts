import { allowAttempt } from "@/lib/server/admin-store";
import { accountRequest, accountResponse, attemptKey } from "@/lib/server/accounts";
import { parseMatterportLink } from "@/lib/matterport-link";
import { linkHelp, lookupMatterport, lookupText } from "@/lib/server/matterport";

/**
 * Checks a Matterport link before a space is made for it: that it opens without signing in, its name for the
 * title and how many 360 photos it has. When Matterport cannot be reached the link is still accepted
 * (`checked: false`); the worker meets the same problems and reports them.
 */
export async function POST(request: Request) {
  const { user, body, error } = await accountRequest(request, 8192, { agents: true });
  if (error) return error;
  const link = parseMatterportLink(body?.url);
  if (!link) return accountResponse({ error: linkHelp }, 400);
  if (!allowAttempt([[attemptKey("matterport-lookup", user.id), 60]], 60 * 60 * 1000)) return accountResponse({ error: "Too many links checked. Try again later." }, 429);
  try {
    const found = await lookupMatterport(link.modelId);
    if (!found.found) return accountResponse({ error: lookupText[found.reason], reason: found.reason }, found.reason === "missing" ? 404 : 422);
    return accountResponse({ ok: true, link, name: found.name, sweeps: found.sweeps, checked: true });
  } catch (failure) {
    console.error("Unable to check a Matterport link:", failure instanceof Error ? failure.message : failure);
    return accountResponse({ ok: true, link, name: "", sweeps: null, checked: false });
  }
}
