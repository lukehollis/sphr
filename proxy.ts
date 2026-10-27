import { NextResponse, type NextRequest } from "next/server";
import { openToEveryone, sessionCookie } from "@/lib/server/accounts";
import { cookieName as adminCookie } from "@/lib/server/auth";

/**
 * A public space's page is the same for every visitor, so a CDN may keep it for a few minutes (and
 * serve it a while longer as it fetches a new one). A signed-in request, a private or preview space and
 * the viewer's own navigation requests stay private, as Next makes every dynamic page. A release keeps
 * the last one's scripts for two days, so a kept page still loads after a deploy.
 */
const shared = "public, max-age=0, s-maxage=300, stale-while-revalidate=600";

/** The router's requests for a page's data (next.config.mjs keeps them visible here); a CDN ignores Vary, so these never share a page's address. */
const navigation = (request: NextRequest) => request.nextUrl.searchParams.has("_rsc")
  || [...request.headers.keys()].some((name) => name === "rsc" || name === "next-hmr-refresh" || name.startsWith("next-router-"));

function sharedPage(request: NextRequest) {
  const id = request.nextUrl.pathname.match(/^\/s\/([a-f0-9]{12})\/[a-z0-9-]+$/)?.[1];
  return Boolean(id) && (request.method === "GET" || request.method === "HEAD") && !navigation(request)
    && !request.cookies.has(sessionCookie) && !request.cookies.has(adminCookie) && openToEveryone(id!);
}

export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  if (sharedPage(request)) response.headers.set("Cache-Control", shared);
  return response;
}

export const config = { matcher: "/s/:id/:slug" };
