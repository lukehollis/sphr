import { randomBytes } from "node:crypto";
import { allowAttempt, attemptsUsed, isScenePublic } from "./admin-store";
import { AccountError, accountsDatabase, createCustomerSpace, hostingActive, hostingStatuses, payableSpaceCount, PlanLimitError, readCustomerSpace, readSubscription,
  readUser, removeCustomerSpaceRecord, submitCustomerSpace, teamUserIds, type CustomerSpace, type SpaceSource, type SpaceStatus, type User } from "./accounts-store";
import { attemptKey, notifyOwner, publicOrigin, spaceHosted, submitsPerDay } from "./accounts";
import { billingEnabled, syncQuantity } from "./billing";
import { saveEvent } from "./analytics-store";
import { siteBrand } from "./brand";
import { importFinishedEmail } from "./emails";
import { announceJob } from "./job-signal";
import { lookupMatterport, lookupText } from "./matterport";
import { spacePreview } from "./previews";
import { notifyTeam } from "./team-notify";
import { customerAssetBase } from "./worker";
import { parseSceneCatalog } from "../scene-catalog-data";
import type { ListedLink } from "../matterport-link";

// Bringing over many Matterport spaces at once. The customer gives a list of links and confirms once that they
// own the spaces or have permission. Each link waits here until its turn, then becomes an ordinary space made from
// a Matterport link (customer_spaces.source), under the payment and free-preview rules of a single link, and is
// submitted like one. The queue keeps one customer's list from swamping the worker and the account's daily
// submissions: an import keeps `importParallel()` spaces queued or processing at a time and uses at most
// `importDaily()` of the account's daily submissions, leaving the rest for the customer's own uploads. What holds
// a list back (its turn, the day's submissions, payment, a full plan) is said on its page.
//
// The queue moves when a space finishes (the worker's routes), when the import's page asks, after Checkout, and
// once a minute (instrumentation.ts). State shared between route bundles lives on globalThis, like job-signal.ts.

const env = (name: string) => process.env[name]?.trim() || undefined;
function whole(name: string, fallback: number) {
  const value = Number(env(name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
/** Links one import holds at most. */
export const importMaxLinks = () => whole("SPHR_IMPORT_MAX_LINKS", 200);
/** Spaces of one account an import keeps queued or processing at once. */
export const importParallel = () => whole("SPHR_IMPORT_PARALLEL", 1);
/** Submissions in 24 hours imports may use of the account's daily allowance; the rest stay for the customer's own uploads. */
export const importDaily = () => Math.min(whole("SPHR_IMPORT_DAILY", 15), submitsPerDay);
/** Links still waiting across an account's imports. */
const maxWaiting = 500;
const day = 24 * 60 * 60 * 1000;
const now = () => new Date().toISOString();

let prepared = false;
function store() {
  const connection = accountsDatabase();
  if (prepared) return connection;
  connection.exec(`
    CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, permission TEXT NOT NULL, created TEXT NOT NULL, finished TEXT);
    CREATE INDEX IF NOT EXISTS imports_user ON imports(user_id);
    CREATE TABLE IF NOT EXISTS import_items (id TEXT PRIMARY KEY, import_id TEXT NOT NULL, position INTEGER NOT NULL, model_id TEXT NOT NULL,
      url TEXT NOT NULL, title TEXT, name TEXT, sweeps INTEGER, state TEXT NOT NULL, reason TEXT, checks INTEGER NOT NULL DEFAULT 0, space_id TEXT,
      updated TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS import_items_import ON import_items(import_id, position);
    CREATE INDEX IF NOT EXISTS import_items_space ON import_items(space_id);
    CREATE INDEX IF NOT EXISTS import_items_state ON import_items(state);
  `);
  prepared = true;
  return connection;
}

function transaction<T>(work: () => T): T {
  const connection = store();
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    connection.exec("COMMIT");
    return result;
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
}

/**
 * checking: its link is being checked with Matterport. waiting: its turn has not come. refused: it will not come over
 * (the reason says why). started: it has a space, whose status says the rest. skipped: the customer took it off the list.
 */
export type ItemState = "checking" | "waiting" | "refused" | "started" | "skipped";
type ItemRow = { id: string; import_id: string; position: number; model_id: string; url: string; title: string | null; name: string | null; sweeps: number | null;
  state: ItemState; reason: string | null; checks: number; space_id: string | null; updated: string };
type ImportRow = { id: string; user_id: string; permission: string; created: string; finished: string | null };
export type Import = { id: string; userId: string; permission: string; created: string; finished: string | null };
const toImport = (row: ImportRow): Import => ({ id: row.id, userId: row.user_id, permission: row.permission, created: row.created, finished: row.finished });

/** What holds an account's imports back, when anything does. */
export type Blocker =
  | { kind: "turn" }
  | { kind: "daily"; until: string | null }
  | { kind: "payment" }
  | { kind: "plan"; spaces: number }
  | { kind: "limit"; message: string }
  | { kind: "billing" };

/** `opening` holds lists whose request is still making their first space (the free preview, or one for Checkout): the queue leaves them alone. */
type Shared = { blockers: Map<string, Blocker | null>; locks: Map<string, Promise<unknown>>; advanced: Map<string, number>; opening: Set<string>;
  checking?: Promise<void>; watching?: ReturnType<typeof setInterval> };
const global = globalThis as typeof globalThis & { __sphrImports?: Shared };
const shared: Shared = global.__sphrImports ??= { blockers: new Map(), locks: new Map(), advanced: new Map(), opening: new Set() };

/** One account's queue moves one step at a time, whichever route asks. */
function locked<T>(key: string, work: () => Promise<T>) {
  const next = (shared.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  shared.locks.set(key, next);
  void next.finally(() => { if (shared.locks.get(key) === next) shared.locks.delete(key); }).catch(() => undefined);
  return next;
}

const log = (label: string) => (error: unknown) => console.error(label, error instanceof Error ? error.message : error);

export function readImport(id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{12}$/.test(id)) return undefined;
  const row = store().prepare("SELECT * FROM imports WHERE id=?").get(id) as ImportRow | undefined;
  return row ? toImport(row) : undefined;
}

/** The imports of the customer and their team, newest first. */
export function listImports(userId: string) {
  const users = teamUserIds(userId);
  return (store().prepare(`SELECT * FROM imports WHERE user_id IN (${users.map(() => "?").join(",")}) ORDER BY created DESC LIMIT 50`).all(...users) as ImportRow[])
    .map(toImport);
}

/** The import a space was brought over by, if any. */
export function importOfSpace(spaceId: string) {
  const row = store().prepare("SELECT import_id FROM import_items WHERE space_id=? AND state='started'").get(spaceId) as { import_id: string } | undefined;
  return row ? readImport(row.import_id) : undefined;
}

/** Matterport spaces the account has or is bringing over: a space already there, or a link waiting in another import. */
function knownModels(userId: string) {
  const users = teamUserIds(userId);
  const marks = users.map(() => "?").join(",");
  const spaces = new Map<string, string>();
  for (const row of store().prepare(`SELECT id, source FROM customer_spaces WHERE user_id IN (${marks}) AND status<>'deleted' AND source IS NOT NULL`).all(...users) as { id: string; source: string }[]) {
    try { const source = JSON.parse(row.source) as SpaceSource; if (source.kind === "matterport") spaces.set(source.modelId, row.id); } catch { /* not a link */ }
  }
  const waiting = new Set((store().prepare(`SELECT i.model_id FROM import_items i JOIN imports m ON m.id=i.import_id
    WHERE m.user_id IN (${marks}) AND i.state IN ('checking','waiting')`).all(...users) as { model_id: string }[]).map(row => row.model_id));
  return { spaces, waiting };
}

export const alreadyThere = "Already in your spaces.";
export const alreadyComing = "Already on its way in another list.";

/**
 * Keeps a list of links, each to be checked with Matterport. A space the account already has, or is already bringing
 * over, is listed but not brought over again. `permission` is when the customer confirmed they may bring them over.
 */
export function createImport(userId: string, links: ListedLink[], permission: string) {
  return transaction(() => {
    const users = teamUserIds(userId);
    const { waiting: open } = store().prepare(`SELECT count(*) AS waiting FROM import_items i JOIN imports m ON m.id=i.import_id
      WHERE m.user_id IN (${users.map(() => "?").join(",")}) AND i.state IN ('checking','waiting')`).get(...users) as { waiting: number };
    if (open + links.length > maxWaiting) throw new AccountError(`Your account already has ${open} Matterport spaces waiting to come over. Add more once they are on their way.`);
    const { spaces, waiting } = knownModels(userId);
    const id = randomBytes(6).toString("hex");
    const stamp = now();
    store().prepare("INSERT INTO imports(id, user_id, permission, created) VALUES (?, ?, ?, ?)").run(id, userId, permission, stamp);
    const insert = store().prepare(`INSERT INTO import_items(id, import_id, position, model_id, url, title, state, reason, space_id, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    links.forEach((link, position) => {
      const existing = spaces.get(link.modelId);
      const state: ItemState = existing || waiting.has(link.modelId) ? "refused" : "checking";
      insert.run(randomBytes(8).toString("hex"), id, position, link.modelId, link.url, link.title ?? null, state,
        existing ? alreadyThere : state === "refused" ? alreadyComing : null, existing ?? null, stamp);
    });
    // Its links are checked at once, but the queue waits for the request to finish setting it up (openImport).
    shared.opening.add(id);
    return readImport(id)!;
  });
}

/** The request that made a list has set it up: its links join the account's queue. */
export function openImport(id: string) {
  shared.opening.delete(id);
}

// ---- Checking each link with Matterport, a few at a time ----

async function checkItem(row: ItemRow) {
  try {
    const found = await lookupMatterport(row.model_id);
    if (found.found) store().prepare("UPDATE import_items SET state='waiting', name=?, sweeps=?, updated=? WHERE id=? AND state='checking'").run(found.name || null, found.sweeps, now(), row.id);
    else store().prepare("UPDATE import_items SET state='refused', reason=?, updated=? WHERE id=? AND state='checking'").run(lookupText[found.reason], now(), row.id);
  } catch (failure) {
    // Matterport could not be reached. After three tries the space waits unchecked, as a single link is accepted then: the worker meets any problem itself.
    console.error("Unable to check a Matterport link:", failure instanceof Error ? failure.message : failure);
    store().prepare("UPDATE import_items SET checks=checks+1, state=CASE WHEN checks+1>=3 THEN 'waiting' ELSE state END, updated=? WHERE id=? AND state='checking'")
      .run(now(), row.id);
  }
}

/** Checks the links waiting for it, three at a time, oldest list first, then moves the queues that gained a space. One run at a time. */
export function checkImports(): Promise<void> {
  return shared.checking ??= (async () => {
    const tried = new Set<string>(), users = new Set<string>();
    for (;;) {
      const rows = (store().prepare(`SELECT i.*, m.user_id FROM import_items i JOIN imports m ON m.id=i.import_id WHERE i.state='checking'
        ORDER BY m.created, i.position`).all() as (ItemRow & { user_id: string })[]).filter(row => !tried.has(row.id));
      if (!rows.length) break;
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
        while (next < rows.length) {
          const row = rows[next++];
          tried.add(row.id);
          await checkItem(row);
          // A list's first checked space can start while the rest are checked.
          if (!users.has(row.user_id)) { users.add(row.user_id); void advanceImports(row.user_id).catch(log("Unable to move an import:")); }
        }
      }));
    }
    for (const user of users) await advanceImports(user).catch(log("Unable to move an import:"));
  })().finally(() => { shared.checking = undefined; });
}

/** Waits for the links' checks, at most `ms`: a long list goes on being checked after the page has its answer. */
export function waitForChecks(ms: number) {
  return Promise.race([checkImports(), new Promise<void>(resolve => setTimeout(resolve, ms).unref?.())]);
}

// ---- The queue ----

/** An account's links in the order they come over: those with a space waiting to be submitted or paid for, then those still waiting. */
function lineOf(userId: string) {
  return (store().prepare(`SELECT i.* FROM import_items i JOIN imports m ON m.id=i.import_id LEFT JOIN customer_spaces s ON s.id=i.space_id
    WHERE m.user_id=? AND (i.state='waiting' OR (i.state='started' AND s.status IN ('draft','unpaid'))) ORDER BY m.created, i.position`).all(userId) as ItemRow[])
    .filter(row => !shared.opening.has(row.import_id));
}

function inFlight(userId: string) {
  return (store().prepare(`SELECT count(*) AS count FROM import_items i JOIN imports m ON m.id=i.import_id JOIN customer_spaces s ON s.id=i.space_id
    WHERE m.user_id=? AND i.state='started' AND s.status IN ('queued','processing')`).get(userId) as { count: number }).count;
}

const itemTitle = (item: Pick<ItemRow, "title" | "name" | "model_id">) => item.title || item.name || `Matterport space ${item.model_id}`;

/**
 * Makes the space for a link and marks it started. `preview` spends the account's free preview on it and `unpaid` makes
 * it wait for payment, as the first space of a list does before hosting starts; otherwise it joins the hosting there is.
 * Throws as createCustomerSpace does.
 */
export function startItemSpace(user: User, item: ItemRow, status: "draft" | "unpaid", { preview = false, planSpaces = null as number | null } = {}) {
  const permission = (store().prepare("SELECT permission FROM imports WHERE id=?").get(item.import_id) as { permission: string }).permission;
  const space = createCustomerSpace(user.id, itemTitle(item), status, planSpaces, preview,
    { kind: "matterport", modelId: item.model_id, url: item.url, permission });
  store().prepare("UPDATE import_items SET state='started', space_id=?, updated=? WHERE id=?").run(space.id, now(), item.id);
  saveEvent("space_created", { userId: user.id, props: { from: "import", first: false, source: "matterport", ...(preview ? { preview: true } : {}) } });
  return space;
}

/**
 * The list's first link that can come over, for the free preview or for Checkout to have a space to bill. A link Matterport
 * has not answered for yet counts, as a single link is accepted unchecked.
 */
export function firstWaiting(importId: string) {
  return store().prepare("SELECT * FROM import_items WHERE import_id=? AND state IN ('waiting','checking') ORDER BY state DESC, position LIMIT 1")
    .get(importId) as ItemRow | undefined;
}

/** Makes the next link's space, within the account's hosting and plan. */
async function makeSpace(user: User, item: ItemRow): Promise<CustomerSpace | Blocker> {
  if (!billingEnabled()) return startItemSpace(user, item, "draft");
  const subscription = readSubscription(user.id);
  if (!subscription || !hostingStatuses.has(subscription.status)) return { kind: "payment" };
  let space: CustomerSpace;
  try { space = startItemSpace(user, item, "draft", { planSpaces: subscription.plan?.spaces ?? null }); }
  catch (failure) {
    if (failure instanceof PlanLimitError) return { kind: "plan", spaces: subscription.plan?.spaces ?? 0 };
    if (failure instanceof AccountError) return { kind: "limit", message: failure.message };
    throw failure;
  }
  try { await syncQuantity(user.id); }
  catch (failure) {
    log("Unable to update the subscription quantity:")(failure);
    removeCustomerSpaceRecord(space.id);
    store().prepare("UPDATE import_items SET state='waiting', space_id=NULL, updated=? WHERE id=?").run(now(), item.id);
    return { kind: "billing" };
  }
  return space;
}

/**
 * Before hosting starts, links wait for payment. Checkout bills the spaces an account has, so an account with none
 * gets the next link's space as one waiting for payment, as a single link would.
 */
function awaitPayment(user: User, head: ItemRow): Blocker {
  if (!payableSpaceCount(user.id)) {
    try { startItemSpace(user, head, "unpaid"); }
    catch (failure) { if (!(failure instanceof AccountError)) throw failure; }
  }
  return { kind: "payment" };
}

/** Starts the next link: makes its space if it has none and submits it. Returns what holds it back, or null once it is on its way. */
async function step(user: User, item: ItemRow): Promise<Blocker | null> {
  const submits = attemptKey("submit", user.id);
  const used = attemptsUsed(submits);
  if (used.attempts >= importDaily()) return { kind: "daily", until: used.resets };
  let space = item.space_id ? readCustomerSpace(item.space_id) : undefined;
  if (!space) {
    const made = await makeSpace(user, item);
    if ("kind" in made) return made;
    space = made;
  }
  if (space.status === "unpaid") return { kind: "payment" };
  if (space.status !== "draft") return null;
  // A space is processed while it is hosted, or while it is the account's free preview and has runs left.
  const preview = spaceHosted(space) ? null : spacePreview(space);
  if (!spaceHosted(space) && (!preview?.open || preview.runsLeft < 1)) return { kind: "payment" };
  if (!allowAttempt([[submits, submitsPerDay], [attemptKey("submit-space", space.id), 5]], day)) return { kind: "daily", until: attemptsUsed(submits).resets };
  submitCustomerSpace(space.id, null, "tour");
  announceJob();
  saveEvent("space_submitted", { userId: user.id, props: { files: 0, bytes: 0, from: "import", source: "matterport" } });
  return null;
}

/**
 * Moves an account's imports along: starts links while fewer than `importParallel()` of its spaces are queued or
 * processing and nothing else holds the queue back, then closes the lists that have settled.
 */
export function advanceImports(userId: string) {
  return locked(`imports:${userId}`, () => advance(userId));
}

/** Moves the queue unless it moved a moment ago, for pages that ask every few seconds. A move under way is waited for. */
export function freshenImports(userId: string) {
  return locked(`imports:${userId}`, async () => Date.now() - (shared.advanced.get(userId) ?? 0) < 3000 && shared.blockers.has(userId)
    ? shared.blockers.get(userId) ?? null : advance(userId));
}

async function advance(userId: string): Promise<Blocker | null> {
  shared.advanced.set(userId, Date.now());
  const user = readUser(userId);
  if (!user) return null;
  let blocker: Blocker | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const [head] = lineOf(userId);
    if (!head) { blocker = null; break; }
    if (!head.space_id && billingEnabled() && !hostingActive(userId)) { blocker = awaitPayment(user, head); break; }
    if (inFlight(userId) >= importParallel()) { blocker = { kind: "turn" }; break; }
    blocker = await step(user, head);
    if (blocker) break;
  }
  shared.blockers.set(userId, blocker);
  await closeImports(userId);
  return blocker;
}

/** Settled: nothing waits, and every space it made is ready, needs attention or was deleted. */
const settled = `NOT EXISTS (SELECT 1 FROM import_items i LEFT JOIN customer_spaces s ON s.id=i.space_id WHERE i.import_id=imports.id
  AND (i.state IN ('checking','waiting') OR (i.state='started' AND s.status IN ('unpaid','draft','queued','processing'))))`;

/** Closes the account's lists that have settled, and tells the customer and the team once for each list that brought anything over. */
async function closeImports(userId: string) {
  const open = (store().prepare(`SELECT * FROM imports WHERE user_id=? AND finished IS NULL AND ${settled}`).all(userId) as ImportRow[])
    .filter(row => !shared.opening.has(row.id));
  for (const row of open) {
    if (store().prepare("UPDATE imports SET finished=? WHERE id=? AND finished IS NULL").run(now(), row.id).changes !== 1) continue;
    const view = describeImport(toImport(row));
    // A list that brought nothing over, or whose spaces were all deleted, ends quietly.
    if (!view.counts.ready && !view.counts.failed) continue;
    const user = readUser(row.user_id);
    saveEvent("import_finished", { userId: row.user_id, props: { ready: view.counts.ready, failed: view.counts.failed, refused: view.counts.refused } });
    void notifyTeam({ title: "Matterport list brought over", tone: view.counts.failed ? "warn" : "good", fields: [["Account", user?.email], ["Ready", view.counts.ready],
      ["Need attention", view.counts.failed], ["Not brought over", view.counts.refused + view.counts.skipped], ["Started", row.created]] });
    void notifyOwner(user, importFinishedEmail(siteBrand(), publicOrigin(), { id: row.id, counts: view.counts,
      failed: view.items.filter(item => item.status === "failed").map(item => item.title) }));
  }
}

/** Accounts whose lists are still open. */
function openImportUsers() {
  return (store().prepare("SELECT DISTINCT user_id FROM imports WHERE finished IS NULL").all() as { user_id: string }[]).map(row => row.user_id);
}

/** Every minute: checks links, and moves queues held back by time (the day's submissions) or by things that happen elsewhere (payment). */
export function watchImports() {
  if (shared.watching) return;
  shared.watching = setInterval(async () => {
    try {
      const { accountsEnabled } = await import("./accounts");
      if (!accountsEnabled()) return;
      void checkImports().catch(log("Unable to check Matterport links:"));
      for (const userId of openImportUsers()) await advanceImports(userId).catch(log("Unable to move an import:"));
    } catch (error) { log("Unable to move the imports:")(error); }
  }, 60_000);
  shared.watching.unref?.();
}

/** Takes one waiting link off a list. */
export function skipItem(importId: string, itemId: unknown) {
  if (typeof itemId !== "string" || !/^[a-f0-9]{16}$/.test(itemId)) return false;
  return store().prepare("UPDATE import_items SET state='skipped', updated=? WHERE id=? AND import_id=? AND state IN ('checking','waiting')")
    .run(now(), itemId, importId).changes === 1;
}

/** Takes every waiting link off a list; spaces already made stay. */
export function stopImport(importId: string) {
  return store().prepare("UPDATE import_items SET state='skipped', updated=? WHERE import_id=? AND state IN ('checking','waiting')").run(now(), importId).changes;
}

// ---- What the customer sees ----

export type ItemStatus = "checking" | "waiting" | "refused" | "skipped" | Exclude<SpaceStatus, "unpaid" | "draft">;
type ViewRow = ItemRow & { space_status: SpaceStatus | null; space_title: string | null; space_message: string | null; scene_id: string | null; listing: string | null;
  progress: string | null };

function scenePath(listing: string | null) {
  if (!listing) return null;
  try { return parseSceneCatalog(JSON.stringify({ spaces: [JSON.parse(listing)] }), customerAssetBase())[0]?.scenePath ?? null; }
  catch { return null; }
}

/**
 * A list as its page shows it: every link with what it became or what it waits for, the counts, and what holds the
 * queue back. A waiting link's `ahead` is how many come over before it; `after` is when its day's submissions free up,
 * when that is later than now.
 */
export function describeImport(imp: Import) {
  const rows = store().prepare(`SELECT i.*, s.status AS space_status, s.title AS space_title, s.message AS space_message, s.scene_id, s.listing,
      (SELECT progress FROM jobs j WHERE j.space_id=s.id AND j.status='running' ORDER BY j.created DESC LIMIT 1) AS progress
    FROM import_items i LEFT JOIN customer_spaces s ON s.id=i.space_id WHERE i.import_id=? ORDER BY i.position`).all(imp.id) as ViewRow[];
  const blocker = imp.finished ? null : shared.blockers.get(imp.userId) ?? null;
  const line = lineOf(imp.userId).map(row => row.id);
  const used = attemptsUsed(attemptKey("submit", imp.userId));
  const daily = importDaily();
  const room = Math.max(0, daily - used.attempts);
  const resets = used.resets ? Date.parse(used.resets) : Date.now() + day;
  const counts = { total: rows.length, started: 0, ready: 0, working: 0, waiting: 0, failed: 0, refused: 0, skipped: 0, deleted: 0 };
  // Only time holds back links that have no other reason to wait.
  const timed = !blocker || blocker.kind === "turn" || blocker.kind === "daily";
  const items = rows.map(row => {
    const status: ItemStatus = row.state !== "started" ? row.state
      : !row.space_status ? "deleted" : row.space_status === "unpaid" || row.space_status === "draft" ? "waiting" : row.space_status;
    if (row.state === "started") counts.started++;
    if (status === "ready") counts.ready++;
    else if (status === "queued" || status === "processing") counts.working++;
    else if (status === "checking" || status === "waiting") counts.waiting++;
    else if (status === "failed") counts.failed++;
    else if (status === "refused") counts.refused++;
    else if (status === "skipped") counts.skipped++;
    else if (status === "deleted") counts.deleted++;
    const place = line.indexOf(row.id);
    // Links past today's submissions start once a later day's window opens.
    const later = !timed ? null : blocker?.kind === "daily" ? Math.floor(Math.max(place, 0) / daily) * day + (blocker.until ? Date.parse(blocker.until) : resets)
      : place >= room ? Math.floor((place - room) / daily) * day + resets : null;
    const space = row.space_id && row.space_status && row.space_status !== "deleted" && (row.state === "started" || row.reason === alreadyThere)
      ? readCustomerSpace(row.space_id) : undefined;
    return {
      id: row.id, url: row.url, modelId: row.model_id, title: row.space_title ?? itemTitle(row), sweeps: row.sweeps, status,
      reason: row.state === "refused" ? row.reason : null,
      ahead: status === "waiting" && place >= 0 ? place : null,
      after: status === "waiting" && place >= 0 && later !== null && later > Date.now() ? new Date(later).toISOString() : null,
      space: space ? {
        id: space.id, status: space.status, message: row.space_message, progress: row.progress,
        path: space.status === "ready" ? scenePath(row.listing) : null, public: Boolean(row.scene_id && space.status === "ready" && isScenePublic(row.scene_id)),
        preview: Boolean(spacePreview(space))
      } : null
    };
  });
  return { id: imp.id, created: imp.created, finished: imp.finished, permission: imp.permission, counts, items, daily, perDay: submitsPerDay,
    parallel: importParallel(), blocker, hosting: !billingEnabled() || hostingActive(imp.userId) };
}
export type ImportView = ReturnType<typeof describeImport>;

/** A list in a few numbers, for the account's pages: `total` counts the links coming over, not those left out. */
export function summarizeImport(imp: Import) {
  const counts = store().prepare(`SELECT sum(CASE WHEN i.state IN ('refused','skipped') THEN 0 ELSE 1 END) AS total,
      sum(CASE WHEN i.state='started' AND s.status='ready' THEN 1 ELSE 0 END) AS ready,
      sum(CASE WHEN i.state IN ('checking','waiting') OR (i.state='started' AND s.status IN ('unpaid','draft')) THEN 1 ELSE 0 END) AS waiting,
      sum(CASE WHEN i.state='started' AND s.status IN ('queued','processing') THEN 1 ELSE 0 END) AS working,
      sum(CASE WHEN i.state='started' AND s.status='failed' THEN 1 ELSE 0 END) AS failed
    FROM import_items i LEFT JOIN customer_spaces s ON s.id=i.space_id WHERE i.import_id=?`).get(imp.id) as Record<string, number | null>;
  return { id: imp.id, created: imp.created, finished: imp.finished, total: counts.total ?? 0, ready: counts.ready ?? 0, waiting: counts.waiting ?? 0,
    working: counts.working ?? 0, failed: counts.failed ?? 0 };
}
export type ImportSummary = ReturnType<typeof summarizeImport>;
