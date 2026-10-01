import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isAdmin } from "./auth";
import { reportClientError } from "./error-report";
import { analyticsEnabled, clean, cleanProps, cookieDomain, describeDevice, externalReferrer, keepDays, otherOrigins, ownOrigin, saveEvent, seeVisitor,
  serverEvents, setInternal, visitorCookie, type Props } from "./analytics-store";

// The request side of the site's own analytics (see analytics-store.ts): the visitor cookie,
// steps recorded by routes, and the endpoint pages send their events to.

export { accountSource, analyticsEnabled } from "./analytics-store";

const visitorPattern = /^[a-f0-9]{32}$/;
const namePattern = /^[a-z][a-z0-9_]{1,39}$/;
const bots = /bot|crawl|spider|slurp|preview|curl|wget|python|httpx|go-http|java\/|headless|lighthouse|monitor|scanner/i;

async function visitorFromCookie() {
  try {
    const value = (await cookies()).get(visitorCookie)?.value;
    return value && visitorPattern.test(value) ? value : undefined;
  } catch { return undefined; }
}

/**
 * Records a step the server saw: a sign-up, a payment, a finished upload. The visitor comes
 * from the request's cookie when there is one, and a signed-in step ties that visitor to the account.
 */
export async function recordEvent(name: string, { userId = null, props }: { userId?: string | null; props?: Props } = {}) {
  if (!analyticsEnabled()) return;
  saveEvent(name, { visitor: await visitorFromCookie() ?? null, userId, props });
}

/** Leaves the operator's own browser out of the numbers. */
export async function markInternal() {
  if (!analyticsEnabled()) return;
  const visitor = await visitorFromCookie();
  if (visitor) setInternal(visitor);
}

// ---- Events from pages ----

const limits = new Map<string, { count: number; reset: number }>();
function allowed(address: string) {
  const now = Date.now();
  if (limits.size > 5000) for (const [key, entry] of limits) if (entry.reset < now) limits.delete(key);
  const entry = limits.get(address);
  if (!entry || entry.reset < now) { limits.set(address, { count: 1, reset: now + 60000 }); return true; }
  return ++entry.count <= 120;
}

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return origin && otherOrigins().includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" }
    : {};
}

async function readText(request: Request, maxBytes: number) {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  for (let length = 0; ;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    length += value.length;
    if (length > maxBytes) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
}

/**
 * Takes events a page sends with `navigator.sendBeacon` or a keepalive fetch: page views, clicks
 * and the steps of the upload sheet. A first visit gets the visitor cookie and its first touch is kept.
 */
export async function collect(request: Request) {
  const origin = request.headers.get("origin");
  const headers = { "Cache-Control": "no-store", ...corsHeaders(request) };
  if (!analyticsEnabled()) return new Response(null, { status: 404 });
  // Pages that send no referrer (the email confirmation page) make Safari and Firefox send Origin: null;
  // the browser's own Sec-Fetch-Site still says whether the page is this site's.
  const sameSite = origin === "null" && request.headers.get("sec-fetch-site") === "same-origin";
  if (!sameSite && (!origin || (origin !== ownOrigin() && !otherOrigins().includes(origin)))) return new Response(null, { status: 403 });
  const agent = request.headers.get("user-agent") ?? "";
  const done = () => new Response(null, { status: 204, headers });
  if (!agent || bots.test(agent) || !allowed(request.headers.get("x-real-ip") || "local")) return done();
  let body;
  try { body = JSON.parse(await readText(request, 16384) ?? ""); } catch { return new Response(null, { status: 400, headers }); }
  const events = (Array.isArray(body?.events) ? body.events : []).slice(0, 20)
    .filter((event: { name?: unknown }) => typeof event?.name === "string" && namePattern.test(event.name) && !serverEvents.has(event.name));
  if (!events.length) return done();
  const visitor = await visitorFromCookie() ?? randomBytes(16).toString("hex");
  const country = clean(request.headers.get("cf-ipcountry"), 2).toUpperCase();
  seeVisitor(visitor, { referrer: body.referrer, url: body.url, agent, country: /^[A-Z]{2}$/.test(country) && country !== "XX" ? country : null });
  // The people who run the site are left out of the numbers.
  if (await isAdmin()) setInternal(visitor);
  for (const event of events) {
    const props = cleanProps(event.props) ?? {};
    if (event.name === "page_view") {
      const linked = externalReferrer(body.referrer);
      if (linked) props.ref = linked;
    }
    saveEvent(event.name, { visitor, path: clean(event.path, 200) || null, props });
    if (event.name === "client_error") reportClientError(props, clean(event.path, 200) || null, describeDevice(agent));
  }
  const response = new NextResponse(null, { status: 204, headers });
  // Renewed on each visit; the domain lets a sibling site (the homepage) share it.
  const domain = cookieDomain();
  const host = new URL(ownOrigin()).hostname;
  response.cookies.set(visitorCookie, visitor, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/",
    maxAge: keepDays * 86400, ...(domain && (host === domain || host.endsWith(`.${domain}`)) ? { domain } : {}) });
  return response;
}
