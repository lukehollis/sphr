import { NextResponse } from "next/server";
import { allowAttempt } from "@/lib/server/admin-store";
import { createOAuthState } from "@/lib/server/accounts-store";
import { accountsEnabled, publicOrigin, safeReturnPath } from "@/lib/server/accounts";
import { authorizationUrl, oauthProvider } from "@/lib/server/oauth";
import { setOAuthCookie } from "@/lib/server/oauth-cookie";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const provider = oauthProvider((await params).provider);
  if (!accountsEnabled() || !provider) return new Response(null, { status: 404 });
  const origin = publicOrigin(request);
  // Site-wide only, as for email sign-up: many people can share one network address.
  if (!allowAttempt([["account-oauth", 2000]])) {
    return NextResponse.redirect(new URL("/account/login?error=busy", origin), 303);
  }
  const check = createOAuthState(provider.id, safeReturnPath(new URL(request.url).searchParams.get("next")));
  const response = NextResponse.redirect(authorizationUrl(provider, origin, check), 303);
  setOAuthCookie(response, check.state);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
