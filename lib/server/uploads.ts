import { createSign } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Upload } from "./accounts-store";
import { serialized } from "./serialize";

// Customer uploads go to a private bucket (or, without one, the private state directory).
// Browsers upload directly to Cloud Storage through resumable sessions started here, so
// multi-gigabyte captures never pass through the application server.
export const chunkSize = 8 * 1024 * 1024;
const env = (name: string) => process.env[name]?.trim() || undefined;
export const uploadBucket = () => env("SPHR_UPLOAD_BUCKET");
export const maxSpaceBytes = () => Number(env("SPHR_UPLOAD_MAX_GB") ?? 50) * 1e9;

export function safeFileName(value: unknown) {
  if (typeof value !== "string") return undefined;
  const name = value.normalize("NFC").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"*:<>?|[\]#]/g, "_").trim().slice(-180);
  return name && !/^\.+$/.test(name) ? name : undefined;
}

export function objectName(spaceId: string, uploadId: string, name: string) {
  return `uploads/${spaceId}/${uploadId}/${name}`;
}

function localRoot() {
  const state = env("SPHR_STATE_DIR");
  if (!state) throw new Error("SPHR_STATE_DIR must be configured for uploads.");
  return path.join(state, "uploads");
}

export function localPath(object: string) {
  const root = localRoot();
  const file = path.resolve(root, object);
  if (!file.startsWith(root + path.sep)) throw new Error("Invalid upload path.");
  return file;
}

let token: { value: string; expires: number } | undefined;

/** Service account key file when configured, otherwise the Compute Engine metadata server. */
export async function accessToken() {
  if (token && token.expires > Date.now() + 60000) return token.value;
  const keyFile = env("GOOGLE_APPLICATION_CREDENTIALS");
  let response: Response;
  if (keyFile) {
    const key = JSON.parse(await readFile(keyFile, "utf8")) as { client_email: string; private_key: string; token_uri?: string };
    const audience = key.token_uri || "https://oauth2.googleapis.com/token";
    const issued = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: key.client_email, scope: "https://www.googleapis.com/auth/devstorage.read_write", aud: audience, iat: issued, exp: issued + 3600 })}`;
    const assertion = `${body}.${createSign("RSA-SHA256").update(body).sign(key.private_key, "base64url")}`;
    response = await fetch(audience, { method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  } else {
    response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) });
  }
  if (!response.ok) throw new Error(`Storage credentials unavailable: HTTP ${response.status}`);
  const result = await response.json() as { access_token: string; expires_in: number };
  token = { value: result.access_token, expires: Date.now() + result.expires_in * 1000 };
  return token.value;
}

const objectUrl = (object: string) => `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(uploadBucket()!)}/o/${encodeURIComponent(object)}`;

/** Returns the URL the browser sends chunks to. */
export async function startUploadSession(upload: Upload, origin: string, localUrl: string) {
  if (!uploadBucket()) {
    await mkdir(path.dirname(localPath(upload.object)), { recursive: true, mode: 0o700 });
    await rm(localPath(upload.object), { force: true });
    return localUrl;
  }
  const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(uploadBucket()!)}/o`);
  url.search = new URLSearchParams({ uploadType: "resumable", name: upload.object, ifGenerationMatch: "0" }).toString();
  // Cloud Storage adds CORS headers for this origin to every later request in the session.
  const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15000), headers: {
    Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json; charset=UTF-8", Origin: origin,
    "X-Upload-Content-Type": upload.type, "X-Upload-Content-Length": String(upload.size) },
    body: JSON.stringify({ metadata: { space: upload.spaceId, upload: upload.id } }) });
  const session = response.headers.get("location");
  if (!response.ok || !session?.startsWith("https://storage.googleapis.com/")) throw new Error(`Upload could not start: HTTP ${response.status}`);
  return session;
}

/** Bytes the storage service has persisted; the browser resumes from here after an interruption. */
export async function uploadOffset(upload: Upload) {
  if (!uploadBucket()) return (await stat(localPath(upload.object)).catch(() => undefined))?.size ?? 0;
  if (!upload.session) return 0;
  const response = await fetch(upload.session, { method: "PUT", signal: AbortSignal.timeout(15000), headers: { "Content-Range": `bytes */${upload.size}`, "Content-Length": "0" } });
  if (response.status === 200 || response.status === 201) return upload.size;
  if (response.status !== 308) throw new Error(`Upload status unavailable: HTTP ${response.status}`);
  const range = response.headers.get("range")?.match(/^bytes=0-(\d+)$/);
  return range ? Number(range[1]) + 1 : 0;
}

/** Confirms the stored object is complete and exactly the declared size. */
export async function verifyUpload(upload: Upload) {
  if (!uploadBucket()) return (await stat(localPath(upload.object)).catch(() => undefined))?.size === upload.size;
  const response = await fetch(objectUrl(upload.object), { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Upload status unavailable: HTTP ${response.status}`);
  return Number((await response.json() as { size: string }).size) === upload.size;
}

export async function deleteStoredUpload(upload: Upload) {
  if (!uploadBucket()) { await rm(localPath(upload.object), { force: true }); return; }
  if (upload.session) await fetch(upload.session, { method: "DELETE", signal: AbortSignal.timeout(15000) }).catch(() => undefined);
  const response = await fetch(objectUrl(upload.object), { method: "DELETE", headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok && response.status !== 404) throw new Error(`Upload could not be removed: HTTP ${response.status}`);
}

/**
 * Local storage speaks the same chunk protocol as a Cloud Storage session:
 * `Content-Range: bytes start-end/total`, 308 while incomplete, 200 when done.
 */
export function writeLocalChunk(upload: Upload, request: Request) {
  // One chunk at a time per upload, so concurrent requests cannot interleave appends.
  return serialized(`upload:${upload.id}`, () => appendLocalChunk(upload, request));
}

async function appendLocalChunk(upload: Upload, request: Request) {
  const range = request.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  const file = localPath(upload.object);
  const current = (await stat(file).catch(() => undefined))?.size ?? 0;
  if (!range || !request.body) return { status: 400, offset: current };
  const [start, end, total] = range.slice(1).map(Number);
  if (total !== upload.size || start !== current || end < start || end >= total || end - start + 1 > chunkSize) return { status: 416, offset: current };
  let received = 0;
  const limited = Readable.fromWeb(request.body as WebReadableStream<Uint8Array>).on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > end - start + 1) limited.destroy(new Error("Chunk larger than its range."));
  });
  try {
    await pipeline(limited, createWriteStream(file, { flags: "a", mode: 0o600 }));
  } catch {
    return { status: 400, offset: (await stat(file)).size };
  }
  const offset = (await stat(file)).size;
  if (offset !== end + 1) return { status: 400, offset };
  return { status: offset === total ? 200 : 308, offset };
}
