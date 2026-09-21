import { cookies } from "next/headers";
import { accessControlled, validSession } from "./admin-store";

export const cookieName = process.env.NODE_ENV === "production" ? "__Host-sphr-admin" : "sphr-admin";
export const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };
export async function isAdmin() {
  return accessControlled() && validSession((await cookies()).get(cookieName)?.value);
}

export function sameOrigin(request: Request) {
  const expected = process.env.SPHR_PUBLIC_URL || new URL(request.url).origin;
  return request.headers.get("origin") === new URL(expected).origin;
}

export async function readAdminBody(request: Request, maxBytes = 4096) {
  if (!sameOrigin(request)) throw new Error("Invalid origin");
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("Invalid content type");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) { await reader.cancel(); throw new Error("Body too large"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function adminResponse(body: object, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
