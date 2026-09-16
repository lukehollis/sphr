import { cookies } from "next/headers";
import { accessControlled, allowLogin, checkCredentials, createSession, deleteSession } from "@/lib/server/admin-store";
import { adminResponse, cookieName, cookieOptions, readAdminBody } from "@/lib/server/auth";

export async function POST(request: Request) {
  if (!accessControlled()) return adminResponse({ error: "Administration is unavailable." }, 404);
  let body;
  try { body = await readAdminBody(request); } catch { return adminResponse({ error: "Invalid request." }, 400); }
  if (typeof body?.username !== "string" || typeof body?.password !== "string" || body.username.length > 64 || body.password.length > 256) return adminResponse({ error: "Invalid username or password." }, 400);
  // Nginx overwrites X-Real-IP. The Node service only listens on loopback.
  if (!allowLogin(request.headers.get("x-real-ip") || "local")) return adminResponse({ error: "Too many sign-in attempts. Try again in 15 minutes." }, 429);
  if (!(await checkCredentials(body.username, body.password))) return adminResponse({ error: "Invalid username or password." }, 401);
  const jar = await cookies();
  deleteSession(jar.get(cookieName)?.value);
  const session = createSession();
  jar.set(cookieName, session.token, { ...cookieOptions, maxAge: session.maxAge });
  return adminResponse({ ok: true });
}
