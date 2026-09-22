import { readCustomerSpace, readUpload, setUploadStatus } from "@/lib/server/accounts-store";
import { accountResponse, accountsEnabled, currentUser, sameOrigin } from "@/lib/server/accounts";
import { editableStatus } from "@/lib/server/customer-spaces";
import { deleteStoredUpload, uploadBucket, uploadOffset, writeLocalChunk } from "@/lib/server/uploads";

type Params = { params: Promise<{ id: string }> };

// Browsers omit Origin on same-origin GET requests; reads need only the session.
async function ownedUpload(request: Request, params: Params["params"], checkOrigin = true) {
  if (!accountsEnabled() || (checkOrigin && !sameOrigin(request))) return undefined;
  const user = await currentUser();
  const upload = readUpload((await params).id);
  const space = upload && readCustomerSpace(upload.spaceId);
  return user && upload && space && space.userId === user.id && upload.status !== "deleted" && space.status !== "deleted" ? { upload, space } : undefined;
}

/** Local storage only: receives one chunk, like a Cloud Storage resumable session. */
export async function PUT(request: Request, { params }: Params) {
  const owned = await ownedUpload(request, params);
  if (!owned || uploadBucket()) return accountResponse({ error: "Upload not found." }, 404);
  if (owned.upload.status !== "uploading") return accountResponse({ error: "This upload is finished." }, 409);
  const result = await writeLocalChunk(owned.upload, request);
  return accountResponse({ offset: result.offset }, result.status);
}

/** Persisted bytes, for resuming after an interruption. */
export async function GET(request: Request, { params }: Params) {
  const owned = await ownedUpload(request, params, false);
  if (!owned) return accountResponse({ error: "Upload not found." }, 404);
  if (owned.upload.status === "complete") return accountResponse({ offset: owned.upload.size });
  try { return accountResponse({ offset: await uploadOffset(owned.upload) }); }
  catch { return accountResponse({ error: "Upload status is unavailable. Try again." }, 502); }
}

export async function DELETE(request: Request, { params }: Params) {
  const owned = await ownedUpload(request, params);
  if (!owned) return accountResponse({ error: "Upload not found." }, 404);
  if (!editableStatus(owned.space) && owned.upload.status === "complete") return accountResponse({ error: "Files cannot be removed while this space is being processed." }, 409);
  try { await deleteStoredUpload(owned.upload); }
  catch { return accountResponse({ error: "The file could not be removed. Try again." }, 502); }
  setUploadStatus(owned.upload.id, "deleted");
  return accountResponse({ ok: true });
}
