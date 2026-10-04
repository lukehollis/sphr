import { accountResponse } from "@/lib/server/accounts";
import { ownedTourRequest } from "@/lib/server/user-tours";
import { saveTourThumbnail } from "@/lib/server/tour-thumbnails";

const maxBytes = 8 * 1024 * 1024;
const tooLarge = "Thumbnails can be up to 8 MB.";

/**
 * Sets a tour's own thumbnail from the image sent as the request body (JPEG, PNG or WebP), such
 * as a frame of the tour at `/t/<id>/<title>?stop=N&frame`. Cards and link previews use it in
 * place of the space's thumbnail.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tour, error } = await ownedTourRequest(request, (await params).id, 0, { body: "none" });
  if (error) return error;
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return accountResponse({ error: tooLarge }, 413);
  const reader = request.body?.getReader();
  if (!reader) return accountResponse({ error: "Send the image as the request body." }, 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) { await reader.cancel(); return accountResponse({ error: tooLarge }, 413); }
    chunks.push(value);
  }
  try { return accountResponse({ ok: true, url: await saveTourThumbnail(tour.id, Buffer.concat(chunks)) }); }
  catch (failure) { return accountResponse({ error: (failure as Error).message }, 400); }
}
