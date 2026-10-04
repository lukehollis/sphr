import { accountRequest, accountResponse } from "@/lib/server/accounts";
import { followCounts, ProfileError, readProfileByHandle, setFollowing } from "@/lib/server/profiles";
import { recordEvent } from "@/lib/server/analytics";

type Params = { params: Promise<{ handle: string }> };

async function change(request: Request, { params }: Params, on: boolean) {
  const { user, error } = await accountRequest(request, 256);
  if (error) return error;
  const profile = readProfileByHandle((await params).handle);
  if (!profile) return accountResponse({ error: "Profile not found." }, 404);
  try { setFollowing(user.id, profile.userId, on); }
  catch (failure) {
    if (failure instanceof ProfileError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
  if (on) void recordEvent("followed", { userId: user.id });
  return accountResponse({ ok: true, following: on, followers: followCounts(profile.userId).followers });
}

/** Follows a person. */
export const PUT = (request: Request, context: Params) => change(request, context, true);
/** Stops following a person. */
export const DELETE = (request: Request, context: Params) => change(request, context, false);
