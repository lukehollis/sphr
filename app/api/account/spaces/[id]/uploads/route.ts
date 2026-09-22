import { AccountError, createUploadRecord, readCustomerSpace, setUploadSession, setUploadStatus } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, publicOrigin, spaceHosted } from "@/lib/server/accounts";
import { editableStatus } from "@/lib/server/customer-spaces";
import { chunkSize, maxSpaceBytes, objectName, safeFileName, startUploadSession } from "@/lib/server/uploads";

/** Registers one file and returns the resumable session the browser uploads it to. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, body, error } = await accountRequest(request);
  if (error) return error;
  const space = readCustomerSpace((await params).id);
  if (!space || space.userId !== user.id || space.status === "deleted") return accountResponse({ error: "Space not found." }, 404);
  if (space.status === "unpaid") return accountResponse({ error: "Complete payment before uploading." }, 402);
  if (!spaceHosted(space)) return accountResponse({ error: "Update your billing details to continue." }, 402);
  if (!editableStatus(space)) return accountResponse({ error: "Files cannot be added while this space is being processed." }, 409);
  const name = safeFileName(body?.name);
  const size = body?.size;
  if (!name) return accountResponse({ error: "Invalid file name." }, 400);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxSpaceBytes()) return accountResponse({ error: "This file is empty or too large." }, 400);
  const type = typeof body?.type === "string" && /^[\w.+-]{1,100}\/[\w.+-]{1,100}$/.test(body.type) ? body.type : "application/octet-stream";
  let upload;
  try { upload = createUploadRecord(space.id, name, size, type, id => objectName(space.id, id, name), maxSpaceBytes()); }
  catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
  try {
    const url = await startUploadSession(upload, publicOrigin(request), `/api/account/uploads/${upload.id}`);
    setUploadSession(upload.id, url);
    return accountResponse({ ok: true, upload: { id: upload.id, name, size, status: upload.status }, url, chunkSize });
  } catch (failure) {
    setUploadStatus(upload.id, "deleted");
    console.error("Unable to start an upload:", failure instanceof Error ? failure.message : failure);
    return accountResponse({ error: "The upload could not start. Try again." }, 502);
  }
}
