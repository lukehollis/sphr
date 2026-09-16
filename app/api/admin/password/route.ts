import { cookies } from "next/headers";
import { changePassword, createSession, allowLogin } from "@/lib/server/admin-store";
import { adminResponse, cookieName, cookieOptions, isAdmin, readAdminBody } from "@/lib/server/auth";

export async function POST(request: Request) {
  if (!(await isAdmin())) return adminResponse({ error: "Sign in to continue." }, 401);
  let body;
  try { body = await readAdminBody(request); } catch { return adminResponse({ error: "Invalid request." }, 400); }
  if (typeof body?.current !== "string" || typeof body?.replacement !== "string" || body.current.length > 256 || body.replacement.length < 8 || body.replacement.length > 256) return adminResponse({ error: "Use a password with 8–256 characters." }, 400);
  if (!allowLogin(`password:${request.headers.get("x-real-ip") || "local"}`)) return adminResponse({ error: "Too many attempts. Try again in 15 minutes." }, 429);
  if (!(await changePassword(body.current, body.replacement))) return adminResponse({ error: "Current password is incorrect." }, 400);
  const session = createSession();
  (await cookies()).set(cookieName, session.token, { ...cookieOptions, maxAge: session.maxAge });
  return adminResponse({ ok: true });
}
