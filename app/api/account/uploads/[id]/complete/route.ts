import { readCustomerSpace, readUpload, setUploadStatus } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse } from "@/lib/server/accounts";
import { uploadOffset, verifyUpload } from "@/lib/server/uploads";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await accountRequest(request);
  if (error) return error;
  const upload = readUpload((await params).id);
  const space = upload && readCustomerSpace(upload.spaceId);
  if (!upload || !space || space.userId !== user.id || upload.status === "deleted" || space.status === "deleted") return accountResponse({ error: "Upload not found." }, 404);
  if (upload.status === "complete") return accountResponse({ ok: true });
  try {
    if (!(await verifyUpload(upload))) return accountResponse({ error: "The upload is incomplete.", offset: await uploadOffset(upload).catch(() => 0) }, 409);
  } catch { return accountResponse({ error: "Upload status is unavailable. Try again." }, 502); }
  setUploadStatus(upload.id, "complete");
  return accountResponse({ ok: true });
}
