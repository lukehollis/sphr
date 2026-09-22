import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { readUpload } from "@/lib/server/accounts-store";
import { accountsEnabled } from "@/lib/server/accounts";
import { localPath, uploadBucket } from "@/lib/server/uploads";
import { workerAuthorized, workerResponse } from "@/lib/server/worker";

/** Local storage only; with a bucket, workers read gs:// URIs with their own credentials. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!accountsEnabled() || !workerAuthorized(request)) return workerResponse({ error: "Unauthorized." }, 401);
  const upload = readUpload((await params).id);
  if (!upload || upload.status !== "complete" || uploadBucket()) return workerResponse({ error: "Upload not found." }, 404);
  const file = localPath(upload.object);
  const size = (await stat(file).catch(() => undefined))?.size;
  if (size === undefined) return workerResponse({ error: "Upload not found." }, 404);
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: {
    "Content-Type": "application/octet-stream", "Content-Length": String(size), "Cache-Control": "no-store" } });
}
