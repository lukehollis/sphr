import { db } from "./admin-store";

// First-party usage analytics. A cookie holds a random visitor ID; the state database keeps
// where each visitor first came from and the steps they take (pages, sign-up, upload,
// payment), so the operator can see who arrives, from where, and where they stop. Nothing
// leaves this server. Off unless NEXT_PUBLIC_SPHR_ANALYTICS=1 at build time.
//   SPHR_ANALYTICS_COOKIE_DOMAIN  share the visitor cookie with a sibling site (e.g. the marketing site)
//   SPHR_ANALYTICS_ORIGINS        comma list of other origins allowed to send events (that site)
// This file has no Next.js imports so billing and the tests can record steps; lib/server/analytics.ts
// adds the request side (the cookie and the endpoint pages send to).

export type Props = Record<string, string | number | boolean>;
export type Touch = { source: string; medium: string; campaign: string | null; referrer: string | null; landing: string | null };

export const visitorCookie = "sphr_vid";
export const keepDays = 400;
// Steps only the server can vouch for; pages cannot send them.
export const serverEvents = new Set(["sign_up", "login", "login_failed", "logout", "verify_sent", "email_verified", "password_reset",
  "space_created", "checkout_started", "checkout_failed", "subscription_started", "subscription_ended", "space_submitted", "space_ready", "space_failed",
  "space_deleted", "agent_linked"]);
let prepared = false;

export function analyticsEnabled() {
  return process.env.NEXT_PUBLIC_SPHR_ANALYTICS === "1";
}

export function analyticsStore() {
  const connection = db();
  if (prepared) return connection;
  connection.exec(`
    CREATE TABLE IF NOT EXISTS analytics_visitors (id TEXT PRIMARY KEY, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, user_id TEXT,
      source TEXT NOT NULL, medium TEXT NOT NULL, campaign TEXT, referrer TEXT, landing TEXT, country TEXT, device TEXT,
      internal INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS analytics_visitors_user ON analytics_visitors(user_id);
    CREATE TABLE IF NOT EXISTS analytics_events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, visitor TEXT, user_id TEXT, name TEXT NOT NULL,
      path TEXT, props TEXT);
    CREATE INDEX IF NOT EXISTS analytics_events_at ON analytics_events(at);
    CREATE INDEX IF NOT EXISTS analytics_events_visitor ON analytics_events(visitor);
    CREATE INDEX IF NOT EXISTS analytics_events_user ON analytics_events(user_id);
  `);
  connection.prepare("DELETE FROM analytics_events WHERE at < ?").run(new Date(Date.now() - keepDays * 86400000).toISOString());
  prepared = true;
  return connection;
}

// ---- Where a visit came from ----

const known: [RegExp, string, string][] = [
  [/(^|\.)gemini\.google\.com$/, "Gemini", "ai"],
  [/(^|\.)google\.[a-z.]+$/, "Google", "search"],
  [/(^|\.)bing\.com$/, "Bing", "search"],
  [/(^|\.)duckduckgo\.com$/, "DuckDuckGo", "search"],
  [/(^|\.)yahoo\.[a-z.]+$/, "Yahoo", "search"],
  [/(^|\.)baidu\.com$/, "Baidu", "search"],
  [/(^|\.)yandex\.[a-z.]+$/, "Yandex", "search"],
  [/(^|\.)ecosia\.org$/, "Ecosia", "search"],
  [/(^|\.)search\.brave\.com$/, "Brave Search", "search"],
  [/(^|\.)kagi\.com$/, "Kagi", "search"],
  [/(^|\.)(chatgpt\.com|chat\.openai\.com)$/, "ChatGPT", "ai"],
  [/(^|\.)claude\.ai$/, "Claude", "ai"],
  [/(^|\.)perplexity\.ai$/, "Perplexity", "ai"],
  [/(^|\.)copilot\.microsoft\.com$/, "Copilot", "ai"],
  [/(^|\.)(x\.com|twitter\.com|t\.co)$/, "X", "social"],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, "LinkedIn", "social"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "Facebook", "social"],
  [/(^|\.)instagram\.com$/, "Instagram", "social"],
  [/(^|\.)reddit\.com$/, "Reddit", "social"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "YouTube", "social"],
  [/(^|\.)news\.ycombinator\.com$/, "Hacker News", "social"],
  [/(^|\.)(discord\.com|discordapp\.com)$/, "Discord", "social"],
  [/(^|\.)bsky\.app$/, "Bluesky", "social"],
  [/(^|\.)threads\.(net|com)$/, "Threads", "social"],
  [/(^|\.)github\.com$/, "GitHub", "referral"]
];
// Pages a visit passes through on the way (payment, sign-in providers) are not where it came from.
const flowHosts = /(^|\.)(stripe\.com|accounts\.google\.com|appleid\.apple\.com)$/;

export const otherOrigins = () => (process.env.SPHR_ANALYTICS_ORIGINS ?? "").split(",").map(item => item.trim()).filter(Boolean)
  .flatMap(item => { try { return [new URL(item).origin]; } catch { return []; } });
export const cookieDomain = () => process.env.SPHR_ANALYTICS_COOKIE_DOMAIN?.trim().replace(/^\./, "").toLowerCase() || undefined;
export const ownOrigin = () => new URL(process.env.SPHR_PUBLIC_URL || "http://localhost:3002").origin;

export function ownHost(host: string) {
  const domain = cookieDomain();
  return [ownOrigin(), ...otherOrigins()].some(origin => new URL(origin).hostname === host) || Boolean(domain && (host === domain || host.endsWith(`.${domain}`)));
}

function parse(value: unknown) {
  if (typeof value !== "string" || !value) return undefined;
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url : undefined; } catch { return undefined; }
}

export const clean = (value: unknown, max: number) => typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "";

/** An outside page that linked here, as host and path; own pages and payment or sign-in steps do not count. */
export function externalReferrer(referrer: unknown) {
  const url = parse(referrer);
  if (!url || ownHost(url.hostname) || flowHosts.test(url.hostname)) return null;
  return `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 200);
}

/** Campaign tags win, then the linking site (named when it is a known search engine, AI assistant or social site), then direct. */
export function firstTouch(referrer: unknown, page: unknown): Touch {
  const url = parse(page);
  const params = url?.searchParams;
  const landing = url ? `${url.hostname}${url.pathname}`.slice(0, 200) : null;
  const linked = externalReferrer(referrer);
  const tagged = clean(params?.get("utm_source") || params?.get("ref"), 60);
  if (tagged) return { source: tagged, medium: clean(params?.get("utm_medium"), 40) || "campaign", campaign: clean(params?.get("utm_campaign"), 80) || null, referrer: linked, landing };
  if (!linked) return { source: "Direct", medium: "direct", campaign: null, referrer: null, landing };
  const host = linked.split("/")[0];
  const match = known.find(([pattern]) => pattern.test(host));
  return { source: match?.[1] ?? host, medium: match?.[2] ?? "referral", campaign: null, referrer: linked, landing };
}

export function describeDevice(agent: string) {
  const kind = /iPad|Tablet/i.test(agent) ? "Tablet" : /Mobi|iPhone|Android/i.test(agent) ? "Phone" : "Desktop";
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\/|FxiOS/.test(agent) ? "Firefox" : /Chrome\/|CriOS/.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Other";
  return `${kind}, ${browser}`;
}

// ---- Recording ----

export function cleanProps(value: unknown): Props | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(([key, item]) => /^[a-z][a-z0-9_]{0,29}$/i.test(key)
    && (typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))).slice(0, 12)
    .map(([key, item]) => [key, typeof item === "string" ? clean(item, 200) : item]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Stores one step. A step with both a visitor and an account ties that visitor (browser) to the account. */
export function saveEvent(name: string, { visitor = null, userId = null, path = null, props }:
  { visitor?: string | null; userId?: string | null; path?: string | null; props?: Props } = {}) {
  if (!analyticsEnabled()) return;
  try {
    const details = cleanProps(props);
    analyticsStore().prepare("INSERT INTO analytics_events(at, visitor, user_id, name, path, props) VALUES (?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), visitor, userId, name, path, details ? JSON.stringify(details) : null);
    if (visitor && userId) analyticsStore().prepare("UPDATE analytics_visitors SET user_id=? WHERE id=? AND user_id IS NULL").run(userId, visitor);
  } catch (error) { console.error("Unable to record analytics:", error instanceof Error ? error.message : error); }
}

/** Adds a visitor the first time they are seen, keeping where they came from; later visits update the time. */
export function seeVisitor(id: string, { referrer, url, country, agent }: { referrer: unknown; url: unknown; country: string | null; agent: string }) {
  const connection = analyticsStore();
  const now = new Date().toISOString();
  if (connection.prepare("SELECT id FROM analytics_visitors WHERE id=?").get(id)) {
    connection.prepare("UPDATE analytics_visitors SET last_seen=? WHERE id=?").run(now, id);
    return;
  }
  const touch = firstTouch(referrer, url);
  connection.prepare(`INSERT INTO analytics_visitors(id, first_seen, last_seen, source, medium, campaign, referrer, landing, country, device)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, now, now, touch.source, touch.medium, touch.campaign, touch.referrer, touch.landing, country, describeDevice(agent));
}

/** Leaves a browser (the operator's) out of the numbers. */
export function setInternal(visitor: string) {
  analyticsStore().prepare("UPDATE analytics_visitors SET internal=1 WHERE id=?").run(visitor);
}

/** Where an account first came from, for the operator's sign-up notice. */
export function accountSource(userId: string) {
  if (!analyticsEnabled()) return undefined;
  const row = analyticsStore().prepare("SELECT source, medium, campaign, referrer FROM analytics_visitors WHERE user_id=? ORDER BY first_seen LIMIT 1")
    .get(userId) as Touch | undefined;
  if (!row) return undefined;
  const via = row.referrer && row.referrer !== row.source ? row.referrer : row.medium !== "direct" ? row.medium : "";
  return [row.source, via, row.campaign].filter(Boolean).join(", ");
}
