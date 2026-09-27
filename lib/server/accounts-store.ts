import { createHash, randomBytes } from "node:crypto";
import { db, hashPassword, verifyPassword } from "./admin-store";
import { formatBytes } from "../bytes";

// Customer accounts share the admin state database so one backup covers visibility,
// edits, accounts, billing state and the processing queue.
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const dummyHash = `${"0".repeat(64)}:${"0".repeat(128)}`;
let prepared = false;

function store() {
  const connection = db();
  if (prepared) return connection;
  connection.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email_verified INTEGER NOT NULL DEFAULT 0, name TEXT, password TEXT, stripe_customer TEXT UNIQUE,
      checkout_session TEXT, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL,
      created TEXT NOT NULL, PRIMARY KEY(provider, subject));
    CREATE TABLE IF NOT EXISTS user_sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS user_tokens (token TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL,
      nonce TEXT NOT NULL, return_path TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS subscriptions (user_id TEXT PRIMARY KEY, subscription TEXT NOT NULL UNIQUE, item TEXT,
      status TEXT NOT NULL, quantity INTEGER NOT NULL, period_end INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS customer_spaces (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, scene_id TEXT UNIQUE, listing TEXT, notes TEXT, message TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS customer_spaces_user ON customer_spaces(user_id);
    CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, name TEXT NOT NULL,
      size INTEGER NOT NULL, type TEXT NOT NULL, object TEXT NOT NULL, session TEXT, status TEXT NOT NULL, created TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS uploads_space ON uploads(space_id);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, scene_id TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, worker TEXT, message TEXT, progress TEXT, created TEXT NOT NULL, started TEXT, finished TEXT);
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
    CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, received TEXT NOT NULL);
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

const now = () => new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const randomId = (bytes: number) => randomBytes(bytes).toString("hex");

/** Messages safe to show the person who made the request. */
export class AccountError extends Error {}

export function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z0-9-]{2,}$/i.test(email) ? email : undefined;
}

export function cleanText(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return text || null;
}

export function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 256;
}

type UserRow = { id: string; email: string; email_verified: number; name: string | null; password: string | null;
  stripe_customer: string | null; checkout_session: string | null; created: string };
export type User = { id: string; email: string; emailVerified: boolean; name: string | null; hasPassword: boolean;
  providers: string[]; stripeCustomer: string | null; checkoutSession: string | null; created: string };

function toUser(row: UserRow): User {
  const providers = (store().prepare("SELECT provider FROM identities WHERE user_id=? ORDER BY provider").all(row.id) as { provider: string }[])
    .map(item => item.provider);
  return { id: row.id, email: row.email, emailVerified: row.email_verified === 1, name: row.name, hasPassword: Boolean(row.password),
    providers, stripeCustomer: row.stripe_customer, checkoutSession: row.checkout_session, created: row.created };
}

export function readUser(id: string) {
  const row = store().prepare("SELECT * FROM users WHERE id=?").get(id) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

export function readUserByEmail(email: unknown) {
  const address = normalizeEmail(email);
  const row = address ? store().prepare("SELECT * FROM users WHERE email=?").get(address) as UserRow | undefined : undefined;
  return row ? toUser(row) : undefined;
}

export async function createPasswordUser(email: unknown, password: unknown, name: unknown) {
  const address = normalizeEmail(email);
  if (!address) throw new AccountError("Enter a valid email address.");
  if (!validPassword(password)) throw new AccountError("Use a password with 8–256 characters.");
  const id = randomId(12);
  const digest = await hashPassword(password);
  try {
    store().prepare("INSERT INTO users(id, email, name, password, created) VALUES (?, ?, ?, ?, ?)")
      .run(id, address, cleanText(name, 120), digest, now());
  } catch (error) {
    if (/UNIQUE/.test(String(error))) throw new AccountError("An account with this email already exists. Sign in instead.");
    throw error;
  }
  return readUser(id)!;
}

export async function checkUserPassword(email: unknown, password: string) {
  const address = normalizeEmail(email);
  const row = address ? store().prepare("SELECT * FROM users WHERE email=?").get(address) as UserRow | undefined : undefined;
  // Password work is the same whether or not the account exists or has a password.
  const valid = await verifyPassword(password, row?.password ?? dummyHash);
  return row?.password && valid ? toUser(row) : undefined;
}

export async function resetUserPassword(userId: string, password: string) {
  const digest = await hashPassword(password);
  transaction(() => {
    // Receiving the reset email proves control of the address.
    store().prepare("UPDATE users SET password=?, email_verified=1 WHERE id=?").run(digest, userId);
    store().prepare("DELETE FROM user_sessions WHERE user_id=?").run(userId);
    store().prepare("DELETE FROM user_tokens WHERE user_id=?").run(userId);
  });
}

export function markEmailVerified(userId: string) {
  store().prepare("UPDATE users SET email_verified=1 WHERE id=?").run(userId);
  store().prepare("DELETE FROM user_tokens WHERE user_id=? AND purpose='verify'").run(userId);
}

export function createUserSession(userId: string) {
  store().prepare("DELETE FROM user_sessions WHERE expires<=?").run(Date.now());
  const token = randomId(32);
  store().prepare("INSERT INTO user_sessions(token, user_id, expires) VALUES (?, ?, ?)").run(hash(token), userId, Date.now() + sessionLifetime);
  return { token, maxAge: sessionLifetime / 1000 };
}

export function userFromSession(token: string | undefined) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  const row = store().prepare(`SELECT users.* FROM user_sessions JOIN users ON users.id=user_sessions.user_id
    WHERE user_sessions.token=? AND user_sessions.expires>?`).get(hash(token), Date.now()) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

export function deleteUserSession(token: string | undefined) {
  if (token) store().prepare("DELETE FROM user_sessions WHERE token=?").run(hash(token));
}

export function createUserToken(userId: string, purpose: "verify" | "reset", lifetime: number) {
  const token = randomId(32);
  transaction(() => {
    store().prepare("DELETE FROM user_tokens WHERE expires<=? OR (user_id=? AND purpose=?)").run(Date.now(), userId, purpose);
    store().prepare("INSERT INTO user_tokens(token, user_id, purpose, expires) VALUES (?, ?, ?, ?)").run(hash(token), userId, purpose, Date.now() + lifetime);
  });
  return token;
}

/** Single use: a valid token is deleted as it is read. */
export function consumeUserToken(token: unknown, purpose: "verify" | "reset") {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  return transaction(() => {
    const row = store().prepare("SELECT user_id FROM user_tokens WHERE token=? AND purpose=? AND expires>?")
      .get(hash(token), purpose, Date.now()) as { user_id: string } | undefined;
    store().prepare("DELETE FROM user_tokens WHERE token=?").run(hash(token));
    return row?.user_id;
  });
}

export function createOAuthState(provider: string, returnPath: string) {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  store().prepare("DELETE FROM oauth_states WHERE expires<=?").run(Date.now());
  store().prepare("INSERT INTO oauth_states VALUES (?, ?, ?, ?, ?, ?)").run(hash(state), provider, verifier, nonce, returnPath, Date.now() + 10 * 60 * 1000);
  return { state, verifier, nonce };
}

export function consumeOAuthState(state: unknown, provider: string) {
  if (typeof state !== "string" || state.length > 128) return undefined;
  return transaction(() => {
    const row = store().prepare("SELECT verifier, nonce, return_path FROM oauth_states WHERE state=? AND provider=? AND expires>?")
      .get(hash(state), provider, Date.now()) as { verifier: string; nonce: string; return_path: string } | undefined;
    store().prepare("DELETE FROM oauth_states WHERE state=?").run(hash(state));
    return row && { verifier: row.verifier, nonce: row.nonce, returnPath: row.return_path };
  });
}

export type ExternalProfile = { provider: string; label: string; subject: string; email?: string; emailVerified: boolean; name?: string | null };

/**
 * Signs in with a provider identity, creating or joining the account for its verified email.
 * Joining an account that has a password removes that password and every session: whoever
 * set it may not own the address (a pre-registered account), and the provider has now
 * proven who does. The owner can set a new password with a reset link.
 */
export function signInWithIdentity(profile: ExternalProfile) {
  return transaction(() => {
    const linked = store().prepare("SELECT user_id FROM identities WHERE provider=? AND subject=?")
      .get(profile.provider, profile.subject) as { user_id: string } | undefined;
    if (linked) return { user: readUser(linked.user_id)!, passwordRemoved: false };
    const email = normalizeEmail(profile.email);
    if (!email || !profile.emailVerified) throw new AccountError(`${profile.label} did not share a verified email address. Use another sign-in method.`);
    const existing = store().prepare("SELECT * FROM users WHERE email=?").get(email) as UserRow | undefined;
    const id = existing?.id ?? randomId(12);
    const passwordRemoved = Boolean(existing?.password);
    if (!existing) {
      store().prepare("INSERT INTO users(id, email, email_verified, name, created) VALUES (?, ?, 1, ?, ?)").run(id, email, cleanText(profile.name, 120), now());
    } else {
      store().prepare("UPDATE users SET email_verified=1, name=coalesce(name, ?) WHERE id=?").run(cleanText(profile.name, 120), id);
      if (passwordRemoved) {
        store().prepare("UPDATE users SET password=NULL WHERE id=?").run(id);
        store().prepare("DELETE FROM user_sessions WHERE user_id=?").run(id);
        store().prepare("DELETE FROM user_tokens WHERE user_id=?").run(id);
      }
    }
    store().prepare("INSERT INTO identities(provider, subject, user_id, created) VALUES (?, ?, ?, ?)").run(profile.provider, profile.subject, id, now());
    return { user: readUser(id)!, passwordRemoved };
  });
}

export function setStripeCustomer(userId: string, customer: string) {
  store().prepare("UPDATE users SET stripe_customer=? WHERE id=? AND stripe_customer IS NULL").run(customer, userId);
  return readUser(userId)!.stripeCustomer!;
}

export function userIdForCustomer(customer: string) {
  return (store().prepare("SELECT id FROM users WHERE stripe_customer=?").get(customer) as { id: string } | undefined)?.id;
}

export function setCheckoutSession(userId: string, session: string | null) {
  store().prepare("UPDATE users SET checkout_session=? WHERE id=?").run(session, userId);
}

// ---- Billing state (Stripe remains the source of truth; this is its latest copy) ----

export const hostingStatuses = new Set(["active", "trialing", "past_due"]);
export type Subscription = { id: string; item: string | null; status: string; quantity: number; periodEnd: number | null; cancelAtPeriodEnd: boolean };
type SubscriptionRow = { subscription: string; item: string | null; status: string; quantity: number; period_end: number | null; cancel_at_period_end: number };

export function readSubscription(userId: string): Subscription | undefined {
  const row = store().prepare("SELECT * FROM subscriptions WHERE user_id=?").get(userId) as SubscriptionRow | undefined;
  return row && { id: row.subscription, item: row.item, status: row.status, quantity: row.quantity, periodEnd: row.period_end, cancelAtPeriodEnd: row.cancel_at_period_end === 1 };
}

export function saveSubscription(userId: string, subscription: Subscription) {
  transaction(() => {
    const current = readSubscription(userId);
    // A late event for an older, ended subscription must not replace a live one.
    if (current && current.id !== subscription.id && hostingStatuses.has(current.status) && !hostingStatuses.has(subscription.status)) return;
    store().prepare("DELETE FROM subscriptions WHERE subscription=? AND user_id<>?").run(subscription.id, userId);
    store().prepare(`INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      subscription=excluded.subscription, item=excluded.item, status=excluded.status, quantity=excluded.quantity,
      period_end=excluded.period_end, cancel_at_period_end=excluded.cancel_at_period_end, updated=excluded.updated`)
      .run(userId, subscription.id, subscription.item, subscription.status, subscription.quantity, subscription.periodEnd,
        Number(subscription.cancelAtPeriodEnd), now());
  });
}

export function setSubscriptionQuantity(userId: string, subscription: string, quantity: number) {
  store().prepare("UPDATE subscriptions SET quantity=?, updated=? WHERE user_id=? AND subscription=?").run(quantity, now(), userId, subscription);
}

export function hostingActive(userId: string) {
  const subscription = readSubscription(userId);
  return Boolean(subscription && hostingStatuses.has(subscription.status));
}

export function recordStripeEvent(id: string) {
  store().prepare("INSERT OR IGNORE INTO stripe_events VALUES (?, ?)").run(id, now());
  store().prepare("DELETE FROM stripe_events WHERE received < ?").run(new Date(Date.now() - 30 * 86400000).toISOString());
}

export function seenStripeEvent(id: string) {
  return Boolean(store().prepare("SELECT id FROM stripe_events WHERE id=?").get(id));
}

// ---- Customer spaces ----

export type SpaceStatus = "unpaid" | "draft" | "queued" | "processing" | "ready" | "failed" | "deleted";
export type CustomerSpace = { id: string; userId: string; title: string; status: SpaceStatus; sceneId: string | null;
  notes: string | null; message: string | null; created: string; updated: string };
type SpaceRow = { id: string; user_id: string; title: string; status: SpaceStatus; scene_id: string | null; notes: string | null;
  message: string | null; created: string; updated: string };
const billable = "('draft','queued','processing','ready','failed')";
export const maxSpacesPerAccount = 500;

function toSpace(row: SpaceRow): CustomerSpace {
  return { id: row.id, userId: row.user_id, title: row.title, status: row.status, sceneId: row.scene_id, notes: row.notes,
    message: row.message, created: row.created, updated: row.updated };
}

export function readCustomerSpace(id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{12}$/.test(id)) return undefined;
  const row = store().prepare("SELECT * FROM customer_spaces WHERE id=?").get(id) as SpaceRow | undefined;
  return row ? toSpace(row) : undefined;
}

export function listCustomerSpaces(userId: string) {
  return (store().prepare("SELECT * FROM customer_spaces WHERE user_id=? AND status<>'deleted' ORDER BY created DESC").all(userId) as SpaceRow[]).map(toSpace);
}

export function spaceForScene(sceneId: string) {
  const row = store().prepare("SELECT * FROM customer_spaces WHERE scene_id=?").get(sceneId) as SpaceRow | undefined;
  return row ? toSpace(row) : undefined;
}

export function createCustomerSpace(userId: string, title: string, status: "unpaid" | "draft") {
  return transaction(() => {
    const { count } = store().prepare("SELECT count(*) AS count FROM customer_spaces WHERE user_id=? AND status<>'deleted'").get(userId) as { count: number };
    if (count >= maxSpacesPerAccount) throw new AccountError("This account has reached its space limit. Contact support to add more.");
    if (status === "unpaid") {
      const { waiting } = store().prepare("SELECT count(*) AS waiting FROM customer_spaces WHERE user_id=? AND status='unpaid'").get(userId) as { waiting: number };
      if (waiting >= 10) throw new AccountError("Complete payment for your existing spaces first.");
    }
    const id = randomId(6);
    const stamp = now();
    store().prepare("INSERT INTO customer_spaces(id, user_id, title, status, created, updated) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, title, status, stamp, stamp);
    return readCustomerSpace(id)!;
  });
}

export function removeCustomerSpaceRecord(id: string) {
  // Only for undoing a creation whose billing update failed.
  transaction(() => {
    store().prepare("DELETE FROM customer_spaces WHERE id=? AND scene_id IS NULL").run(id);
    store().prepare("DELETE FROM uploads WHERE space_id=?").run(id);
  });
}

export function renameCustomerSpace(id: string, title: string) {
  store().prepare("UPDATE customer_spaces SET title=?, updated=? WHERE id=? AND status<>'deleted'").run(title, now(), id);
  return readCustomerSpace(id)!;
}

export function deleteCustomerSpace(id: string) {
  transaction(() => {
    store().prepare("UPDATE customer_spaces SET status='deleted', updated=? WHERE id=?").run(now(), id);
    store().prepare("UPDATE jobs SET status='canceled', finished=? WHERE space_id=? AND status IN ('queued','running','held')").run(now(), id);
  });
}

/** Published listings of hosted customer spaces. They are kept out of the shared public catalog. */
export function readCustomerListings(): unknown[] {
  return (store().prepare("SELECT listing FROM customer_spaces WHERE listing IS NOT NULL AND status<>'deleted'").all() as { listing: string }[])
    .map(row => JSON.parse(row.listing));
}

export function billableSpaceCount(userId: string) {
  return (store().prepare(`SELECT count(*) AS count FROM customer_spaces WHERE user_id=? AND status IN ${billable}`).get(userId) as { count: number }).count;
}

/** Spaces a new subscription must cover: everything the customer has not deleted. */
export function payableSpaceCount(userId: string) {
  return (store().prepare("SELECT count(*) AS count FROM customer_spaces WHERE user_id=? AND status<>'deleted'").get(userId) as { count: number }).count;
}

export function activateUnpaidSpaces(userId: string) {
  store().prepare("UPDATE customer_spaces SET status='draft', updated=? WHERE user_id=? AND status='unpaid'").run(now(), userId);
}

// ---- Uploads ----

export type UploadStatus = "uploading" | "complete" | "deleted";
export type Upload = { id: string; spaceId: string; name: string; size: number; type: string; object: string; session: string | null; status: UploadStatus; created: string };
type UploadRow = { id: string; space_id: string; name: string; size: number; type: string; object: string; session: string | null; status: UploadStatus; created: string };
const toUpload = (row: UploadRow): Upload => ({ id: row.id, spaceId: row.space_id, name: row.name, size: row.size, type: row.type,
  object: row.object, session: row.session, status: row.status, created: row.created });
export const maxUploadsPerSpace = 2000;

export function createUploadRecord(spaceId: string, name: string, size: number, type: string, objectFor: (id: string) => string, maxBytes: number) {
  return transaction(() => {
    const totals = store().prepare("SELECT count(*) AS count, coalesce(sum(size), 0) AS bytes FROM uploads WHERE space_id=? AND status<>'deleted'")
      .get(spaceId) as { count: number; bytes: number };
    if (totals.count >= maxUploadsPerSpace) throw new AccountError(`A space can hold up to ${maxUploadsPerSpace} files. Combine files into a ZIP archive.`);
    if (totals.bytes + size > maxBytes) throw new AccountError(`Uploads for one space are limited to ${formatBytes(maxBytes)}.`);
    const id = randomId(8);
    store().prepare("INSERT INTO uploads VALUES (?, ?, ?, ?, ?, ?, NULL, 'uploading', ?)").run(id, spaceId, name, size, type, objectFor(id), now());
    return readUpload(id)!;
  });
}

export function readUpload(id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{16}$/.test(id)) return undefined;
  const row = store().prepare("SELECT * FROM uploads WHERE id=?").get(id) as UploadRow | undefined;
  return row ? toUpload(row) : undefined;
}

export function listUploads(spaceId: string) {
  return (store().prepare("SELECT * FROM uploads WHERE space_id=? AND status<>'deleted' ORDER BY created, name").all(spaceId) as UploadRow[]).map(toUpload);
}

export function setUploadSession(id: string, session: string) {
  store().prepare("UPDATE uploads SET session=? WHERE id=?").run(session, id);
}

export function setUploadStatus(id: string, status: UploadStatus) {
  store().prepare("UPDATE uploads SET status=?, session=CASE WHEN ?='uploading' THEN session ELSE NULL END WHERE id=?").run(status, status, id);
}

export { formatBytes };

// ---- Processing queue ----

// "held" jobs wait for an operator; the customer still sees the space as processing.
export type JobStatus = "queued" | "running" | "held" | "done" | "failed" | "canceled";
export type Job = { id: string; spaceId: string; sceneId: string; status: JobStatus; attempts: number; worker: string | null; message: string | null;
  progress: string | null; created: string; started: string | null; finished: string | null };
type JobRow = { id: string; space_id: string; scene_id: string; status: JobStatus; attempts: number; worker: string | null; message: string | null;
  progress: string | null; created: string; started: string | null; finished: string | null };
const toJob = (row: JobRow): Job => ({ id: row.id, spaceId: row.space_id, sceneId: row.scene_id, status: row.status, attempts: row.attempts,
  worker: row.worker, message: row.message, progress: row.progress, created: row.created, started: row.started, finished: row.finished });
export const maxJobAttempts = 3;

function unusedSceneId() {
  for (;;) {
    const id = randomId(6);
    const taken = store().prepare("SELECT 1 FROM customer_spaces WHERE scene_id=? UNION SELECT 1 FROM jobs WHERE scene_id=?").get(id, id);
    if (!taken) return id;
  }
}

export function submitCustomerSpace(spaceId: string, notes: string | null) {
  return transaction(() => {
    const space = readCustomerSpace(spaceId);
    if (!space || !["draft", "failed", "ready"].includes(space.status)) throw new AccountError("This space cannot be submitted right now.");
    const uploads = listUploads(spaceId);
    if (!uploads.some(upload => upload.status === "complete")) throw new AccountError("Upload at least one file first.");
    if (uploads.some(upload => upload.status === "uploading")) throw new AccountError("Wait for every upload to finish, or remove unfinished files.");
    const id = randomId(8);
    // The scene ID is fixed before processing so a job can only publish its own space.
    store().prepare("INSERT INTO jobs(id, space_id, scene_id, status, created) VALUES (?, ?, ?, 'queued', ?)").run(id, spaceId, space.sceneId ?? unusedSceneId(), now());
    store().prepare("UPDATE customer_spaces SET status='queued', notes=?, message=NULL, updated=? WHERE id=?").run(notes, now(), spaceId);
    return readJob(id)!;
  });
}

export function readJob(id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{16}$/.test(id)) return undefined;
  const row = store().prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | undefined;
  return row ? toJob(row) : undefined;
}

export function listJobs(statuses: JobStatus[]) {
  const marks = statuses.map(() => "?").join(",");
  return (store().prepare(`SELECT * FROM jobs WHERE status IN (${marks}) ORDER BY created`).all(...statuses) as JobRow[]).map(toJob);
}

export function latestJob(spaceId: string) {
  const row = store().prepare("SELECT * FROM jobs WHERE space_id=? ORDER BY created DESC LIMIT 1").get(spaceId) as JobRow | undefined;
  return row ? toJob(row) : undefined;
}

export function claimJob(id: string, worker: string) {
  return transaction(() => {
    const job = readJob(id);
    const space = job && readCustomerSpace(job.spaceId);
    if (!job || job.status !== "queued" || !space || space.status !== "queued") return undefined;
    store().prepare("UPDATE jobs SET status='running', attempts=attempts+1, worker=?, started=?, progress=NULL WHERE id=?").run(worker, now(), id);
    store().prepare("UPDATE customer_spaces SET status='processing', updated=? WHERE id=?").run(now(), job.spaceId);
    return readJob(id)!;
  });
}

/** Returns a running or held job to the queue, e.g. when a worker stops before finishing it. */
export function releaseJob(id: string) {
  return transaction(() => {
    const job = readJob(id);
    if (!job || (job.status !== "running" && job.status !== "held")) return false;
    store().prepare("UPDATE jobs SET status='queued', worker=NULL, started=NULL WHERE id=?").run(id);
    store().prepare("UPDATE customer_spaces SET status='queued', updated=? WHERE id=? AND status='processing'").run(now(), job.spaceId);
    return true;
  });
}

/** The latest step the processing agent reported, shown to the customer while it works. */
export function setJobProgress(id: string, progress: string) {
  return store().prepare("UPDATE jobs SET progress=? WHERE id=? AND status='running'").run(progress, id).changes > 0;
}

/** Parks a running job for an operator, keeping the space in processing. */
export function holdJob(id: string, message: string | null) {
  return transaction(() => {
    const job = readJob(id);
    if (!job || job.status !== "running") return false;
    store().prepare("UPDATE jobs SET status='held', message=? WHERE id=?").run(message, id);
    return true;
  });
}

/**
 * A crashed or stalled worker leaves its job running. After the lease, the job returns to
 * the queue, or waits for an operator once it has used every attempt.
 */
export function expireJobLeases(hours: number) {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  transaction(() => {
    const stale = store().prepare("SELECT * FROM jobs WHERE status='running' AND started < ?").all(cutoff) as JobRow[];
    for (const job of stale) {
      if (job.attempts >= maxJobAttempts) {
        store().prepare("UPDATE jobs SET status='held', message=? WHERE id=?").run(`Stopped after ${job.attempts} attempts without a result.`, job.id);
      } else {
        store().prepare("UPDATE jobs SET status='queued', worker=NULL, started=NULL WHERE id=?").run(job.id);
        store().prepare("UPDATE customer_spaces SET status='queued', updated=? WHERE id=? AND status='processing'").run(now(), job.space_id);
      }
    }
  });
}

export function finishJob(id: string, outcome: { ok: true; message: string | null; listing: object } | { ok: false; message: string }) {
  return transaction(() => {
    const job = readJob(id);
    if (!job || (job.status !== "running" && job.status !== "held")) throw new AccountError("This job is not running.");
    const space = readCustomerSpace(job.spaceId)!;
    if (space.status === "deleted") {
      store().prepare("UPDATE jobs SET status='canceled', message=?, finished=? WHERE id=?").run(outcome.message, now(), id);
      return { job: readJob(id)!, space, previousSceneId: null };
    }
    store().prepare("UPDATE jobs SET status=?, message=?, finished=? WHERE id=?").run(outcome.ok ? "done" : "failed", outcome.message, now(), id);
    if (outcome.ok) {
      store().prepare("UPDATE customer_spaces SET status='ready', scene_id=?, listing=?, message=?, updated=? WHERE id=?")
        .run(job.sceneId, JSON.stringify(outcome.listing), outcome.message, now(), space.id);
    } else {
      store().prepare("UPDATE customer_spaces SET status='failed', message=?, updated=? WHERE id=?").run(outcome.message, now(), space.id);
    }
    return { job: readJob(id)!, space: readCustomerSpace(space.id)!, previousSceneId: space.sceneId !== job.sceneId ? space.sceneId : null };
  });
}
