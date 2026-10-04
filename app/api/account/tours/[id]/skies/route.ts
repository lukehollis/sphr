import { accountResponse } from "@/lib/server/accounts";
import { maxSkyBytes, ModelError, ownedTourRequest, saveTourSky } from "@/lib/server/user-tours";

const tooLarge = "Skies can be up to 20 MB. Save it as a JPEG at 8192 by 4096 or smaller.";

/**
 * Adds the customer's own sky to a tour: a 360 panorama twice as wide as it is tall
 * (JPEG, PNG or WebP) sent as the request body. Returns the address to use as a
 * custom sky's url.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tour, error } = await ownedTourRequest(request, (await params).id, 0, { body: "none" });
  if (error) return error;
  if (Number(request.headers.get("content-length") ?? 0) > maxSkyBytes) return accountResponse({ error: tooLarge }, 413);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (!reader) return accountResponse({ error: "Send the sky image as the request body." }, 400);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxSkyBytes) { await reader.cancel(); return accountResponse({ error: tooLarge }, 413); }
    chunks.push(value);
  }
  try {
    return accountResponse({ ok: true, url: saveTourSky(tour.id, Buffer.concat(chunks)) });
  } catch (failure) {
    if (failure instanceof ModelError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
}
