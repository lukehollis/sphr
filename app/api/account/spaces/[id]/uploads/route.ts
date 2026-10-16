import { AccountError, createUploadRecord, listUploads, PreviewLimitError, readCustomerSpace, sameTeam, setUploadSession, setUploadStatus } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, publicOrigin, spaceHosted } from "@/lib/server/accounts";
import { editableStatus } from "@/lib/server/customer-spaces";
import { previewGateBody, previewOffer, spacePreview } from "@/lib/server/previews";
import { chunkSize, maxSpaceBytes, objectName, safeFileName, startUploadSession, uploadOffset } from "@/lib/server/uploads";

/** Registers one file and returns the resumable session the browser uploads it to. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, body, error } = await accountRequest(request, 4096, { agents: true });
  if (error) return error;
  const space = readCustomerSpace((await params).id);
  if (!space || !sameTeam(space.userId, user.id) || space.status === "deleted") return accountResponse({ error: "Space not found." }, 404);
  if (space.status === "unpaid") {
    return accountResponse({ error: previewOffer(user.id)?.available ? "Start your free preview or complete payment before uploading." : "Complete payment before uploading." }, 402);
  }
  // Hosted spaces upload freely. A free preview does too, until its window ends, but holds fewer files.
  const preview = spaceHosted(space) ? null : spacePreview(space);
  if (!spaceHosted(space) && !preview) return accountResponse({ error: "Update your billing details to continue." }, 402);
  if (preview?.expired) return accountResponse(previewGateBody(space, "ended"), 402);
  if (!editableStatus(space)) return accountResponse({ error: "Files cannot be added while this space is being processed." }, 409);
  const name = safeFileName(body?.name);
  const size = body?.size;
  if (!name) return accountResponse({ error: "Invalid file name." }, 400);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxSpaceBytes()) return accountResponse({ error: "This file is empty or too large." }, 400);
  const type = typeof body?.type === "string" && /^[\w.+-]{1,100}\/[\w.+-]{1,100}$/.test(body.type) ? body.type : "application/octet-stream";
  // The same file chosen again (after a reload, a dropped connection or "Try again") carries on
  // from what storage already holds instead of starting over.
  const unfinished = listUploads(space.id).find(item => item.status === "uploading" && item.name === name && item.size === size && item.session);
  if (unfinished) {
    try {
      const offset = await uploadOffset(unfinished);
      return accountResponse({ ok: true, upload: { id: unfinished.id, name, size, status: unfinished.status }, url: unfinished.session, chunkSize, offset });
    } catch { setUploadStatus(unfinished.id, "deleted"); }
  }
  let upload;
  try { upload = createUploadRecord(space.id, name, size, type, id => objectName(space.id, id, name), maxSpaceBytes(), preview ? { files: preview.files, bytes: preview.bytes } : undefined); }
  catch (failure) {
    if (failure instanceof PreviewLimitError) return accountResponse(previewGateBody(space, "limit", failure.message), 402);
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
