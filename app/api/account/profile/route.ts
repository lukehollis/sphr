import { accountRequest, accountResponse, accountsEnabled, currentUser } from "@/lib/server/accounts";
import { ensureProfile, ProfileError, updateProfile } from "@/lib/server/profiles";

/** The signed-in person's profile. */
export async function GET() {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  const user = await currentUser();
  if (!user) return accountResponse({ error: "Sign in to continue." }, 401);
  return accountResponse({ profile: ensureProfile(user.id) });
}

/** Changes the handle, name, bio, location or website on the signed-in person's profile. */
export async function PATCH(request: Request) {
  const { user, body, error } = await accountRequest(request, 8 * 1024);
  if (error) return error;
  if (!body || typeof body !== "object" || Array.isArray(body)) return accountResponse({ error: "Invalid request." }, 400);
  try { return accountResponse({ ok: true, profile: updateProfile(user.id, body) }); }
  catch (failure) {
    if (failure instanceof ProfileError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
