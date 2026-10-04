import { accountResponse } from "@/lib/server/accounts";
import { maxProfileImageBytes, ProfileError, removeProfileImage, saveProfileImage, type ProfileImageKind } from "@/lib/server/profiles";
import { tourUser } from "@/lib/server/user-tours";

const tooLarge = "Pictures can be up to 15 MB.";
const kindOf = (request: Request): ProfileImageKind | null => {
  const kind = new URL(request.url).searchParams.get("kind");
  return kind === "avatar" || kind === "cover" ? kind : null;
};

/** Replaces the profile picture (?kind=avatar) or cover (?kind=cover) with the image sent as the request body. */
export async function POST(request: Request) {
  const { user, error } = await tourUser(request);
  if (error) return error;
  const kind = kindOf(request);
  if (!kind) return accountResponse({ error: "Say which picture this is." }, 400);
  if (Number(request.headers.get("content-length") ?? 0) > maxProfileImageBytes) return accountResponse({ error: tooLarge }, 413);
  const reader = request.body?.getReader();
  if (!reader) return accountResponse({ error: "Send the picture as the request body." }, 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxProfileImageBytes) { await reader.cancel(); return accountResponse({ error: tooLarge }, 413); }
    chunks.push(value);
  }
  try { return accountResponse({ ok: true, url: await saveProfileImage(user.id, kind, Buffer.concat(chunks)) }); }
  catch (failure) {
    if (failure instanceof ProfileError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}

/** Removes the profile picture or cover. */
export async function DELETE(request: Request) {
  const { user, error } = await tourUser(request);
  if (error) return error;
  const kind = kindOf(request);
  if (!kind) return accountResponse({ error: "Say which picture this is." }, 400);
  removeProfileImage(user.id, kind);
  return accountResponse({ ok: true });
}
