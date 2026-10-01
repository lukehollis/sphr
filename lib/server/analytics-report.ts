import { analyticsStore } from "./analytics-store";
import { hostingStatuses } from "./accounts-store";
import { formatBytes } from "../bytes";

// The operator's view of the analytics: the steps from a first visit to a live space, where
// people came from, and where each account stopped. People are counted once per step; a
// visitor who signs in counts as their account from then on.

type EventRow = { at: string; visitor: string | null; user_id: string | null; name: string; path: string | null; props: string | null };
type VisitorRow = { id: string; first_seen: string; user_id: string | null; source: string; medium: string; campaign: string | null;
  referrer: string | null; landing: string | null; country: string | null; device: string | null; internal: number };
type Event = EventRow & { person: string; data: Record<string, string | number | boolean> };

const steps: { key: string; label: string; test: (event: Event) => boolean }[] = [
  { key: "visit", label: "Visited", test: event => event.name === "page_view" },
  { key: "signin", label: "Reached sign in or sign up", test: event => event.name === "page_view" && /\/account\/(login|signup)$/.test(event.path ?? "") },
  { key: "signup", label: "Created an account", test: event => event.name === "sign_up" },
  { key: "confirmed", label: "Confirmed their email", test: event => event.name === "email_verified" || (event.name === "sign_up" && event.data.method !== "email") },
  { key: "opened", label: "Opened the upload sheet", test: event => event.name === "upload_opened" },
  { key: "files", label: "Chose files", test: event => event.name === "files_chosen" },
  { key: "space", label: "Created a space", test: event => event.name === "space_created" },
  { key: "payment", label: "Opened payment", test: event => event.name === "checkout_opened" },
  { key: "paid", label: "Paid", test: event => event.name === "subscription_started" },
  { key: "uploaded", label: "Uploaded files", test: event => event.name === "space_submitted" },
  { key: "live", label: "Space went live", test: event => event.name === "space_ready" }
];
// The upload sheet's phases, as the place someone left it.
const phases: Record<string, string> = { empty: "before choosing files", creating: "while the space was being made", payment: "at the payment step",
  full: "when their plan was full", uploading: "while files uploaded", countdown: "just before processing", held: "just before processing",
  submitting: "while sending for processing", processing: "after processing started", error: "after an error" };
// Steps that say more about a person than a page view does.
const quiet = new Set(["page_view", "section_view", "cta_click"]);

function count<T>(items: T[], key: (item: T) => string | undefined | null, limit = 12) {
  const counts = new Map<string, number>();
  for (const item of items) { const value = key(item); if (value) counts.set(value, (counts.get(value) ?? 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label, total]) => ({ label, total }));
}

function people<T>(items: T[], key: (item: T) => string | undefined | null, person: (item: T) => string, limit = 12) {
  const sets = new Map<string, Set<string>>();
  for (const item of items) { const value = key(item); if (value) sets.set(value, (sets.get(value) ?? new Set()).add(person(item))); }
  return [...sets].map(([label, set]) => ({ label, total: set.size })).sort((a, b) => b.total - a.total).slice(0, limit);
}

function describe(event: Event) {
  const data = event.data;
  if (event.name === "page_view") return [event.path, data.ref ? `from ${data.ref}` : ""].filter(Boolean).join(" ");
  if (event.name === "cta_click") return [data.label, data.href].filter(Boolean).join(" → ");
  if (event.name === "section_view") return String(data.section ?? "");
  return Object.entries(data).filter(([key, value]) => value !== "" && value !== false && !(value === 0 && key !== "count"))
    .map(([key, value]) => key === "bytes" ? formatBytes(Number(value)) : key === "phase" ? phases[String(value)] ?? String(value)
      : key === "paymentOpened" ? "payment opened" : key === "count" ? `${value} file${value === 1 ? "" : "s"}` : key === "skipped" ? `${value} skipped`
      : `${key} ${value}`).join(", ");
}

function accountStage(row: { email_verified: number; statuses: string | null; sub: string | null }) {
  const statuses = (row.statuses ?? "").split(",").filter(Boolean);
  const live = statuses.filter(status => status !== "deleted");
  if (!row.email_verified) return "Email not confirmed";
  if (!statuses.length) return "No space yet";
  if (!live.length) return "Deleted their space";
  if (live.includes("ready")) return "Live";
  if (live.some(status => status === "queued" || status === "processing")) return "Processing";
  if (live.includes("failed")) return "Needs attention";
  if (live.includes("unpaid") && !(row.sub && hostingStatuses.has(row.sub))) return "Stopped at payment";
  return "Paid, no files yet";
}

export function analyticsReport(days: number) {
  const connection = analyticsStore();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const visitors = connection.prepare("SELECT * FROM analytics_visitors").all() as VisitorRow[];
  const visitorById = new Map(visitors.map(visitor => [visitor.id, visitor]));
  const userOfVisitor = new Map(visitors.filter(visitor => visitor.user_id).map(visitor => [visitor.id, visitor.user_id!]));
  const internalVisitors = new Set(visitors.filter(visitor => visitor.internal).map(visitor => visitor.id));
  const internalUsers = new Set(visitors.filter(visitor => visitor.internal && visitor.user_id).map(visitor => visitor.user_id!));
  const hasAccounts = Boolean(connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get());
  const emails = new Map(hasAccounts ? (connection.prepare("SELECT id, email FROM users").all() as { id: string; email: string }[]).map(row => [row.id, row.email]) : []);

  const rows = connection.prepare("SELECT at, visitor, user_id, name, path, props FROM analytics_events WHERE at >= ? ORDER BY at").all(since) as EventRow[];
  const events: Event[] = [];
  for (const row of rows) {
    const user = row.user_id ?? (row.visitor ? userOfVisitor.get(row.visitor) : undefined);
    if ((row.visitor && internalVisitors.has(row.visitor)) || (user && internalUsers.has(user))) continue;
    const person = user ? `u:${user}` : row.visitor ? `v:${row.visitor}` : undefined;
    if (!person) continue;
    let data = {};
    try { data = row.props ? JSON.parse(row.props) : {}; } catch { /* kept without details */ }
    events.push({ ...row, person, data });
  }

  // Where each person first came from: their earliest visitor record.
  const firstVisitor = new Map<string, VisitorRow>();
  for (const visitor of [...visitors].sort((a, b) => a.first_seen.localeCompare(b.first_seen))) {
    const key = visitor.user_id ? `u:${visitor.user_id}` : `v:${visitor.id}`;
    if (!firstVisitor.has(key)) firstVisitor.set(key, visitor);
  }
  const sourceOf = (person: string) => firstVisitor.get(person)?.source ?? "Unknown";

  const reached = steps.map(step => new Set(events.filter(step.test).map(event => event.person)));
  const funnel = steps.map((step, index) => ({ key: step.key, label: step.label, total: reached[index].size }));

  const everyone = [...new Set(events.map(event => event.person))];
  const sources = new Map<string, { source: string; medium: string; people: number; signups: number; spaces: number; paid: number }>();
  for (const person of everyone) {
    const visitor = firstVisitor.get(person);
    const key = visitor?.source ?? "Unknown";
    const entry = sources.get(key) ?? { source: key, medium: visitor?.medium ?? "", people: 0, signups: 0, spaces: 0, paid: 0 };
    entry.people++;
    if (reached[2].has(person)) entry.signups++;
    if (reached[6].has(person)) entry.spaces++;
    if (reached[8].has(person)) entry.paid++;
    sources.set(key, entry);
  }

  const views = events.filter(event => event.name === "page_view");
  const byPerson = new Map<string, Event[]>();
  for (const event of events) {
    const list = byPerson.get(event.person);
    if (list) list.push(event); else byPerson.set(event.person, [event]);
  }
  const furthest = (person: string) => {
    for (let index = steps.length - 1; index >= 0; index--) if (reached[index].has(person)) return steps[index].label;
    return "Visited";
  };
  const journeys = [...byPerson].filter(([, list]) => list.some(event => !quiet.has(event.name) || steps[1].test(event)))
    .sort((a, b) => b[1].at(-1)!.at.localeCompare(a[1].at(-1)!.at)).slice(0, 40)
    .map(([person, list]) => {
      const visitor = firstVisitor.get(person);
      const user = person.startsWith("u:") ? person.slice(2) : undefined;
      // Repeated views of the same page in a row read as one.
      const trail = list.filter((event, index) => !(event.name === "page_view" && list[index - 1]?.name === "page_view" && list[index - 1]?.path === event.path));
      return { person, label: user ? emails.get(user) ?? "Account" : `Visitor ${person.slice(2, 8)}`, account: Boolean(user),
        source: visitor ? [visitor.source, visitor.referrer && visitor.referrer !== visitor.source ? visitor.referrer : "", visitor.campaign].filter(Boolean).join(", ") : "Unknown",
        landing: visitor?.landing ?? null, country: visitor?.country ?? null, device: visitor?.device ?? null,
        furthest: furthest(person),
        steps: trail.slice(-80).map(event => ({ at: event.at, name: event.name, detail: describe(event) })) };
    });

  const lastSeen = new Map<string, string>();
  for (const event of events) if (event.person.startsWith("u:")) lastSeen.set(event.person.slice(2), event.at);
  const accounts = hasAccounts ? (connection.prepare(`SELECT u.id, u.email, u.email_verified, u.created, u.password IS NOT NULL AS password,
      (SELECT group_concat(provider) FROM identities i WHERE i.user_id=u.id) AS providers,
      (SELECT status FROM subscriptions s WHERE s.user_id=u.id) AS sub,
      (SELECT group_concat(status) FROM customer_spaces c WHERE c.user_id=u.id) AS statuses
    FROM users u ORDER BY u.created DESC LIMIT 200`).all() as { id: string; email: string; email_verified: number; created: string; password: number;
      providers: string | null; sub: string | null; statuses: string | null }[])
    .filter(row => !internalUsers.has(row.id))
    .map(row => ({ email: row.email, created: row.created, method: row.providers ?? (row.password ? "email" : "unknown"),
      source: sourceOf(`u:${row.id}`), stage: accountStage(row), lastSeen: lastSeen.get(row.id) ?? null })) : [];

  return {
    days, since,
    totals: { people: everyone.length, views: views.length, signups: reached[2].size, paid: reached[8].size },
    funnel,
    sources: [...sources.values()].sort((a, b) => b.people - a.people),
    referrers: people(views, event => event.data.ref ? String(event.data.ref) : undefined, event => event.person),
    landings: people(events, event => firstVisitor.get(event.person)?.landing, event => event.person),
    pages: people(views, event => event.path, event => event.person, 20),
    clicks: people(events.filter(event => event.name === "cta_click"), event => String(event.data.label ?? event.data.href ?? ""), event => event.person, 15),
    sections: people(events.filter(event => event.name === "section_view"), event => String(event.data.section ?? ""), event => event.person),
    closes: count(events.filter(event => event.name === "upload_closed" || event.name === "upload_cancelled"),
      event => `${event.name === "upload_cancelled" ? "Cancelled" : "Closed"} ${phases[String(event.data.phase)] ?? String(event.data.phase)}${event.data.paymentOpened ? ", payment opened" : ""}`),
    problems: count(events.filter(event => ["upload_error", "files_rejected", "plan_full", "checkout_failed", "login_failed", "space_failed", "client_error", "server_error"].includes(event.name)),
      event => [event.name.replaceAll("_", " "), event.data.message ?? event.data.kinds ?? ""].filter(Boolean).join(", ")),
    countries: people(events, event => firstVisitor.get(event.person)?.country, event => event.person),
    devices: people(events, event => firstVisitor.get(event.person)?.device, event => event.person),
    journeys,
    accounts
  };
}

export type AnalyticsReport = ReturnType<typeof analyticsReport>;
