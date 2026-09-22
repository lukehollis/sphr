import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AccountError, consumeOAuthState, signInWithIdentity } from "@/lib/server/accounts-store";
import { accountsEnabled, notifyOwner, publicOrigin, startUserSession } from "@/lib/server/accounts";
import { appleName, exchangeCode, oauthProvider } from "@/lib/server/oauth";
import { clearOAuthCookie, oauthCookie } from "@/lib/server/oauth-cookie";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ provider: string }> };
type Callback = { code?: string | null; state?: string | null; error?: string | null; user?: string | null };

function sameState(cookie: string | undefined, state: string | null | undefined) {
  if (!cookie || !state) return false;
  const [expected, supplied] = [Buffer.from(cookie), Buffer.from(state)];
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function finish(request: Request, id: string, callback: Callback) {
  const provider = oauthProvider(id);
  if (!accountsEnabled() || !provider) return new Response(null, { status: 404 });
  const origin = publicOrigin(request);
  const leave = (path: string) => {
    const response = NextResponse.redirect(new URL(path, origin), 303);
    clearOAuthCookie(response);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  if (callback.error) return leave(`/account/login?error=${/cancel|denied/.test(callback.error) ? "cancelled" : "failed"}`);
  // The state must match both this browser's cookie and an unexpired server record.
  if (!sameState((await cookies()).get(oauthCookie)?.value, callback.state)) return leave("/account/login?error=expired");
  const check = consumeOAuthState(callback.state, provider.id);
  if (!check) return leave("/account/login?error=expired");
  let claims;
  try { claims = await exchangeCode(provider, origin, callback.code ?? "", check); }
  catch (error) {
    console.error(`${provider.label} sign-in failed:`, error instanceof Error ? error.message : error);
    return leave("/account/login?error=failed");
  }
  let result;
  try {
    result = signInWithIdentity({ provider: provider.id, label: provider.label, subject: claims.sub, email: claims.email,
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
      name: claims.name ?? (provider.id === "apple" ? appleName(callback.user) : null) });
  } catch (error) {
    if (error instanceof AccountError) return leave(`/account/login?error=email&provider=${provider.id}`);
    throw error;
  }
  if (result.passwordRemoved) {
    await notifyOwner(result.user, `${provider.label} sign-in added to your account`,
      `You signed in to ${origin} with ${provider.label}. Your account's password was removed and other sessions were signed out. To use a password again, choose "Forgot password?" on the sign-in page.`);
  }
  await startUserSession(result.user.id);
  return leave(check.returnPath);
}

export async function GET(request: Request, { params }: Params) {
  const query = new URL(request.url).searchParams;
  return finish(request, (await params).provider, { code: query.get("code"), state: query.get("state"), error: query.get("error") });
}

/** Apple posts the result as a URL-encoded form (response_mode=form_post). */
export async function POST(request: Request, { params }: Params) {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") || !request.body) return new Response(null, { status: 400 });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  for (let length = 0; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 16384) { await reader.cancel(); return new Response(null, { status: 413 }); }
    chunks.push(value);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  return finish(request, (await params).provider, { code: form.get("code"), state: form.get("state"), error: form.get("error"), user: form.get("user") });
}
