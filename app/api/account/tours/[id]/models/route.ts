import { accountResponse } from "@/lib/server/accounts";
import { maxModelBytes, ModelError, ownedTourRequest, saveTourModel } from "@/lib/server/user-tours";

/**
 * Adds a model to a tour: a glTF binary (.glb) sent as the request body, for example one
 * made in Blender. Returns the address to use as an object's source url.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tour, error } = await ownedTourRequest(request, (await params).id, 0, { body: "none" });
  if (error) return error;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxModelBytes) return accountResponse({ error: "Models can be up to 25 MB. Simplify it or compress it with Draco." }, 413);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (!reader) return accountResponse({ error: "Send the .glb file as the request body." }, 400);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxModelBytes) { await reader.cancel(); return accountResponse({ error: "Models can be up to 25 MB. Simplify it or compress it with Draco." }, 413); }
    chunks.push(value);
  }
  try {
    return accountResponse({ ok: true, url: saveTourModel(tour.id, Buffer.concat(chunks)) });
  } catch (failure) {
    if (failure instanceof ModelError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
