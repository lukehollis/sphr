import { NextResponse } from "next/server";
import { consumeUserToken, markEmailVerified } from "@/lib/server/accounts-store";
import { accountResponse, accountsEnabled, publicOrigin, readAccountBody } from "@/lib/server/accounts";

/** Links open a confirmation page; link scanners that prefetch URLs confirm nothing. */
export async function GET(request: Request) {
  if (!accountsEnabled()) return new Response(null, { status: 404 });
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return NextResponse.redirect(new URL(`/account/verify?token=${encodeURIComponent(token)}`, publicOrigin(request)), 303);
}

export async function POST(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  let body;
  try { body = await readAccountBody(request); } catch { return accountResponse({ error: "Invalid request." }, 400); }
  const userId = consumeUserToken(body?.token, "verify");
  if (!userId) return accountResponse({ error: "This link has expired or was already used. Sign in to send a new one." }, 400);
  markEmailVerified(userId);
  return accountResponse({ ok: true });
}
