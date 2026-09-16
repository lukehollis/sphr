import { cookies } from "next/headers";
import { accessControlled, deleteSession } from "@/lib/server/admin-store";
import { adminResponse, cookieName, cookieOptions, sameOrigin } from "@/lib/server/auth";

export async function POST(request: Request) {
  if (!accessControlled()) return adminResponse({ error: "Administration is unavailable." }, 404);
  if (!sameOrigin(request)) return adminResponse({ error: "Invalid request." }, 403);
  const jar = await cookies();
  deleteSession(jar.get(cookieName)?.value);
  jar.set(cookieName, "", { ...cookieOptions, maxAge: 0 });
  return adminResponse({ ok: true });
}
