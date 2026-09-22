import type { NextResponse } from "next/server";

// Apple returns with a cross-site form POST, so the state cookie must be SameSite=None.
const production = process.env.NODE_ENV === "production";
export const oauthCookie = production ? "__Host-sphr-oauth" : "sphr-oauth";
const options = { httpOnly: true, secure: production, sameSite: production ? "none" as const : "lax" as const, path: "/" };

export function setOAuthCookie(response: NextResponse, state: string) {
  response.cookies.set(oauthCookie, state, { ...options, maxAge: 600 });
}

export function clearOAuthCookie(response: NextResponse) {
  response.cookies.set(oauthCookie, "", { ...options, maxAge: 0 });
}
