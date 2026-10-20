import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { db, hashPassword, verifyPassword } from "./admin-store";
import { contactEmail } from "./brand";
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
      updated TEXT NOT NULL, plan TEXT);
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
    CREATE TABLE IF NOT EXISTS agent_links (code TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, client TEXT NOT NULL,
      user_id TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
      client TEXT NOT NULL, created TEXT NOT NULL, used TEXT);
    CREATE INDEX IF NOT EXISTS agent_tokens_user ON agent_tokens(user_id);
    CREATE TABLE IF NOT EXISTS mcp_sessions (id TEXT PRIMARY KEY, client TEXT NOT NULL, secret TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT,
      join_code TEXT NOT NULL UNIQUE, join_domain TEXT, plan_name TEXT, plan_spaces INTEGER,
      created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS team_members (team_id TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('owner','member')), created TEXT NOT NULL,
      PRIMARY KEY(team_id, user_id));
    CREATE INDEX IF NOT EXISTS team_members_team ON team_members(team_id);
    CREATE TABLE IF NOT EXISTS preview_grants (user_id TEXT PRIMARY KEY, space_id TEXT UNIQUE, granted TEXT NOT NULL, ready TEXT,
      max_files INTEGER, max_bytes INTEGER, note TEXT, hosted TEXT);
  `);
  // Databases from before plans were added gain the column; their subscriptions are per space.
  if (!(connection.prepare("PRAGMA table_info(subscriptions)").all() as { name: string }[]).some(column => column.name === "plan")) {
    connection.exec("ALTER TABLE subscriptions ADD COLUMN plan TEXT");
  }
  // What the customer asked the capture to become; spaces from before the choice existed are left to the agent.
  if (!(connection.prepare("PRAGMA table_info(customer_spaces)").all() as { name: string }[]).some(column => column.name === "output")) {
    connection.exec("ALTER TABLE customer_spaces ADD COLUMN output TEXT");
  }
  // A cancellation set for a date (`cancel_at`), which Stripe's Dashboard and portal may schedule instead of one at the period's end.
  if (!(connection.prepare("PRAGMA table_info(subscriptions)").all() as { name: string }[]).some(column => column.name === "cancel_at")) {
    connection.exec("ALTER TABLE subscriptions ADD COLUMN cancel_at INTEGER");
  }
  // When a customer saved a card without hosting anything yet, which is enough to build tours.
  if (!(connection.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some(column => column.name === "card_saved")) {
    connection.exec("ALTER TABLE users ADD COLUMN card_saved TEXT");
  }
  // Jobs of free previews wait behind jobs of hosted spaces.
  if (!(connection.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).some(column => column.name === "preview")) {
    connection.exec("ALTER TABLE jobs ADD COLUMN preview INTEGER NOT NULL DEFAULT 0");
  }
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
  stripe_customer: string | null; checkout_session: string | null; card_saved: string | null; created: string };
export type User = { id: string; email: string; emailVerified: boolean; name: string | null; hasPassword: boolean;
  providers: string[]; stripeCustomer: string | null; checkoutSession: string | null; cardSaved: boolean; created: string };

function toUser(row: UserRow): User {
  const providers = (store().prepare("SELECT provider FROM identities WHERE user_id=? ORDER BY provider").all(row.id) as { provider: string }[])
    .map(item => item.provider);
  return { id: row.id, email: row.email, emailVerified: row.email_verified === 1, name: row.name, hasPassword: Boolean(row.password),
    providers, stripeCustomer: row.stripe_customer, checkoutSession: row.checkout_session, cardSaved: Boolean(row.card_saved), created: row.created };
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
    store().prepare("DELETE FROM agent_tokens WHERE user_id=?").run(userId);
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
    // A new reset link replaces the old one. Confirmation links all stay valid: people often open the first email after asking for another.
    if (purpose === "reset") store().prepare("DELETE FROM user_tokens WHERE user_id=? AND purpose='reset'").run(userId);
    store().prepare("DELETE FROM user_tokens WHERE expires<=?").run(Date.now());
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

// ---- Agents ----
// A person's own agent (Claude, Codex and the like) links to their account the way a TV
// signs in: it shows a short code, the person approves it in a signed-in browser, and the
// agent collects a bearer token. The agent never sees a password or a card.

const linkLifetime = 10 * 60 * 1000;
export const maxAgentTokens = 20;
// No vowels, so codes never spell words; no 0/O or 1/I.
const codeLetters = "BCDFGHJKLMNPQRSTVWXZ23456789";

export function normalizeUserCode(value: unknown) {
  if (typeof value !== "string") return undefined;
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length === 8 && [...code].every(letter => codeLetters.includes(letter)) ? `${code.slice(0, 4)}-${code.slice(4)}` : undefined;
}

export function createAgentLink(client: string) {
  const code = randomId(32);
  const letters = [...randomBytes(8)].map(byte => codeLetters[byte % codeLetters.length]).join("");
  const userCode = `${letters.slice(0, 4)}-${letters.slice(4)}`;
  store().prepare("DELETE FROM agent_links WHERE expires<=?").run(Date.now());
  store().prepare("INSERT INTO agent_links(code, user_code, client, expires) VALUES (?, ?, ?, ?)").run(hash(code), userCode, client, Date.now() + linkLifetime);
  return { code, userCode, expiresIn: linkLifetime / 1000 };
}

export function readAgentLink(userCode: unknown) {
  const code = normalizeUserCode(userCode);
  const row = code ? store().prepare("SELECT client, user_id FROM agent_links WHERE user_code=? AND expires>?").get(code, Date.now()) as
    { client: string; user_id: string | null } | undefined : undefined;
  return row && { userCode: code!, client: row.client, approved: row.user_id !== null };
}

/** Approves a waiting link for the signed-in customer. A link approved once cannot move to another account. */
export function approveAgentLink(userCode: unknown, userId: string) {
  const code = normalizeUserCode(userCode);
  if (!code) return false;
  return store().prepare("UPDATE agent_links SET user_id=? WHERE user_code=? AND expires>? AND user_id IS NULL").run(userId, code, Date.now()).changes === 1;
}

export function denyAgentLink(userCode: unknown) {
  const code = normalizeUserCode(userCode);
  if (code) store().prepare("DELETE FROM agent_links WHERE user_code=? AND user_id IS NULL").run(code);
}

/** The agent's poll. An approved link becomes a token exactly once; the oldest tokens past the limit are dropped. */
export function claimAgentLink(code: unknown): { status: "pending" } | { status: "expired" } | { status: "approved"; token: string; user: User } {
  if (typeof code !== "string" || !/^[a-f0-9]{64}$/.test(code)) return { status: "expired" };
  return transaction(() => {
    const row = store().prepare("SELECT client, user_id FROM agent_links WHERE code=? AND expires>?").get(hash(code), Date.now()) as
      { client: string; user_id: string | null } | undefined;
    if (!row) return { status: "expired" as const };
    if (!row.user_id) return { status: "pending" as const };
    store().prepare("DELETE FROM agent_links WHERE code=?").run(hash(code));
    const token = `sphr_${randomId(32)}`;
    store().prepare("INSERT INTO agent_tokens(id, token, user_id, client, created) VALUES (?, ?, ?, ?, ?)").run(randomId(8), hash(token), row.user_id, row.client, now());
    store().prepare(`DELETE FROM agent_tokens WHERE user_id=? AND id NOT IN
      (SELECT id FROM agent_tokens WHERE user_id=? ORDER BY coalesce(used, created) DESC LIMIT ?)`).run(row.user_id, row.user_id, maxAgentTokens);
    return { status: "approved" as const, token, user: readUser(row.user_id)! };
  });
}

export function userFromAgentToken(token: string | undefined) {
  if (!token || !/^sphr_[a-f0-9]{64}$/.test(token)) return undefined;
  const row = store().prepare("SELECT agent_tokens.id AS token_id, agent_tokens.used AS token_used, users.* FROM agent_tokens JOIN users ON users.id=agent_tokens.user_id WHERE agent_tokens.token=?")
    .get(hash(token)) as (UserRow & { token_id: string; token_used: string | null }) | undefined;
  if (!row) return undefined;
  // Last use is shown on the account page; a minute's precision is plenty.
  if (!row.token_used || Date.parse(row.token_used) < Date.now() - 60000) store().prepare("UPDATE agent_tokens SET used=? WHERE id=?").run(now(), row.token_id);
  return toUser(row);
}

// Hosted MCP sessions (the /mcp endpoint for agents that run in the cloud). A session remembers
// its link code while the person approves it, then the agent token. Both are sealed with a key
// derived from the session ID, which only the agent holds, so the database alone cannot use them.
const mcpSessionLifetime = 30 * 24 * 60 * 60 * 1000;
export type McpSecret = { token?: string; link?: string };
const sessionKey = (id: string) => createHash("sha256").update(`sphr-mcp-session:${id}`).digest();

function seal(id: string, value: McpSecret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(id), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(part => part.toString("base64url")).join(".");
}

function unseal(id: string, value: string | null): McpSecret {
  if (!value) return {};
  try {
    const [iv, tag, data] = value.split(".").map(part => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", sessionKey(id), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")) as McpSecret;
  } catch { return {}; }
}

export function createMcpSession(client: string) {
  const id = randomBytes(24).toString("base64url");
  store().prepare("DELETE FROM mcp_sessions WHERE expires<=?").run(Date.now());
  store().prepare("INSERT INTO mcp_sessions(id, client, expires) VALUES (?, ?, ?)").run(hash(id), client, Date.now() + mcpSessionLifetime);
  return id;
}

/** The session's client and sealed values; each use extends it. */
export function readMcpSession(id: unknown) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(id)) return undefined;
  const row = store().prepare("SELECT client, secret FROM mcp_sessions WHERE id=? AND expires>?").get(hash(id), Date.now()) as
    { client: string; secret: string | null } | undefined;
  if (!row) return undefined;
  store().prepare("UPDATE mcp_sessions SET expires=? WHERE id=?").run(Date.now() + mcpSessionLifetime, hash(id));
  return { id, client: row.client, ...unseal(id, row.secret) };
}

export function saveMcpSecret(id: string, value: McpSecret) {
  store().prepare("UPDATE mcp_sessions SET secret=? WHERE id=?").run(value.token || value.link ? seal(id, value) : null, hash(id));
}

export function deleteMcpSession(id: string) {
  store().prepare("DELETE FROM mcp_sessions WHERE id=?").run(hash(id));
}

export type AgentToken = { id: string; client: string; created: string; used: string | null };

export function listAgentTokens(userId: string): AgentToken[] {
  return (store().prepare("SELECT id, client, created, used FROM agent_tokens WHERE user_id=? ORDER BY created DESC").all(userId) as AgentToken[])
    .map(({ id, client, created, used }) => ({ id, client, created, used }));
}

/** An agent unlinking itself. */
export function deleteAgentToken(token: string | undefined) {
  return Boolean(token && /^sphr_[a-f0-9]{64}$/.test(token) && store().prepare("DELETE FROM agent_tokens WHERE token=?").run(hash(token)).changes === 1);
}

export function revokeAgentToken(userId: string, id: unknown) {
  return typeof id === "string" && store().prepare("DELETE FROM agent_tokens WHERE id=? AND user_id=?").run(id, userId).changes === 1;
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
    if (linked) return { user: readUser(linked.user_id)!, passwordRemoved: false, created: false };
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
        store().prepare("DELETE FROM agent_tokens WHERE user_id=?").run(id);
      }
    }
    store().prepare("INSERT INTO identities(provider, subject, user_id, created) VALUES (?, ?, ?, ?)").run(profile.provider, profile.subject, id, now());
    return { user: readUser(id)!, passwordRemoved, created: !existing };
  });
}

export function setStripeCustomer(userId: string, customer: string) {
  store().prepare("UPDATE users SET stripe_customer=? WHERE id=? AND stripe_customer IS NULL").run(customer, userId);
  return readUser(userId)!.stripeCustomer!;
}

export function userIdForCustomer(customer: string) {
  return (store().prepare("SELECT id FROM users WHERE stripe_customer=?").get(customer) as { id: string } | undefined)?.id;
}

/** Records a card saved on pay as you go before any space, so the customer can build tours. */
export function setCardSaved(userId: string) {
  store().prepare("UPDATE users SET card_saved=? WHERE id=?").run(now(), userId);
}

export function setCheckoutSession(userId: string, session: string | null) {
  store().prepare("UPDATE users SET checkout_session=? WHERE id=?").run(session, userId);
}

// ---- Teams ----
// A team shares spaces, tours and a single billing plan. The team owner pays through Stripe,
// or an enterprise team can be provisioned with an invoiced space allowance (`plan_spaces`)
// and an optional `@domain` restriction on its join link.

export type TeamRole = "owner" | "member";
export type TeamMember = { userId: string; email: string; name: string | null; role: TeamRole; created: string };
export type Team = { id: string; name: string; ownerId: string | null; joinCode: string; joinDomain: string | null;
  planName: string | null; planSpaces: number | null; created: string; updated: string; members: TeamMember[] };
export type UserTeam = { team: Team; role: TeamRole };
type TeamRow = { id: string; name: string; owner_id: string | null; join_code: string; join_domain: string | null;
  plan_name: string | null; plan_spaces: number | null; created: string; updated: string };
type TeamMemberRow = { user_id: string; email: string; name: string | null; role: TeamRole; created: string };

export function normalizeDomain(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new AccountError("Enter a valid email domain, such as example.org.");
  const domain = value.trim().replace(/^@+/, "").toLowerCase();
  if (!domain) return null;
  if (domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    throw new AccountError("Enter a valid email domain, such as example.org.");
  }
  return domain;
}

export function emailDomain(email: string) {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function generateJoinCode(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "team";
  for (;;) {
    const code = `${slug}-${randomId(4)}`;
    const taken = store().prepare("SELECT 1 FROM teams WHERE join_code=?").get(code);
    if (!taken) return code;
  }
}

function toTeam(row: TeamRow): Team {
  const members = (store().prepare(`SELECT team_members.user_id, users.email, users.name, team_members.role, team_members.created
    FROM team_members JOIN users ON users.id = team_members.user_id
    WHERE team_members.team_id=? ORDER BY CASE WHEN team_members.role='owner' THEN 0 ELSE 1 END, team_members.created`)
    .all(row.id) as TeamMemberRow[])
    .map(item => ({ userId: item.user_id, email: item.email, name: item.name, role: item.role, created: item.created }));
  return { id: row.id, name: row.name, ownerId: row.owner_id, joinCode: row.join_code, joinDomain: row.join_domain,
    planName: row.plan_name, planSpaces: row.plan_spaces, created: row.created, updated: row.updated, members };
}

export function readTeam(id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{16,32}$/.test(id)) return undefined;
  const row = store().prepare("SELECT * FROM teams WHERE id=?").get(id) as TeamRow | undefined;
  return row ? toTeam(row) : undefined;
}

export function readTeamByJoinCode(code: unknown) {
  if (typeof code !== "string") return undefined;
  const normalized = code.trim().toLowerCase();
  if (!/^[a-z0-9-]{6,80}$/.test(normalized)) return undefined;
  const row = store().prepare("SELECT * FROM teams WHERE join_code=?").get(normalized) as TeamRow | undefined;
  return row ? toTeam(row) : undefined;
}

export function userTeam(userId: string): UserTeam | undefined {
  const row = store().prepare("SELECT team_id, role FROM team_members WHERE user_id=?").get(userId) as { team_id: string; role: TeamRole } | undefined;
  if (!row) return undefined;
  const team = readTeam(row.team_id);
  return team ? { team, role: row.role } : undefined;
}

export function readUserTeam(userId: string) {
  return userTeam(userId)?.team;
}

export function listTeams(): Team[] {
  return (store().prepare("SELECT * FROM teams ORDER BY created DESC").all() as TeamRow[]).map(toTeam);
}

/** A domain-matched team that this email address is eligible to join. */
export function matchingDomainTeam(email: string): Team | undefined {
  const domain = emailDomain(email);
  if (!domain) return undefined;
  const row = store().prepare("SELECT * FROM teams WHERE join_domain=? ORDER BY created LIMIT 1").get(domain) as TeamRow | undefined;
  return row ? toTeam(row) : undefined;
}

export function teamUserIds(userId: string): string[] {
  const member = store().prepare("SELECT team_id FROM team_members WHERE user_id=?").get(userId) as { team_id: string } | undefined;
  if (!member) return [userId];
  const ids = (store().prepare("SELECT user_id FROM team_members WHERE team_id=? ORDER BY created").all(member.team_id) as { user_id: string }[])
    .map(row => row.user_id);
  return ids.length ? ids : [userId];
}

export function sameTeam(userA: string, userB: string): boolean {
  if (userA === userB) return true;
  return Boolean(store().prepare("SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id WHERE a.user_id=? AND b.user_id=?")
    .get(userA, userB));
}

/** The account whose Stripe subscription covers `userId` (the team owner when in a team). */
export function billingUserId(userId: string): string {
  const row = store().prepare("SELECT teams.owner_id FROM team_members JOIN teams ON teams.id = team_members.team_id WHERE team_members.user_id=?")
    .get(userId) as { owner_id: string | null } | undefined;
  return row?.owner_id ?? userId;
}

export function createTeam(userId: string, input: { name: unknown; joinDomain?: unknown }): Team {
  const name = cleanText(input.name, 80);
  if (!name) throw new AccountError("Enter a team name.");
  const joinDomain = input.joinDomain !== undefined ? normalizeDomain(input.joinDomain) : null;
  return transaction(() => {
    const existing = store().prepare("SELECT team_id FROM team_members WHERE user_id=?").get(userId) as { team_id: string } | undefined;
    if (existing) throw new AccountError("Leave your current team before creating another.");
    const id = randomId(8);
    const joinCode = generateJoinCode(name);
    const stamp = now();
    store().prepare("INSERT INTO teams(id, name, owner_id, join_code, join_domain, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, name, userId, joinCode, joinDomain, stamp, stamp);
    store().prepare("INSERT INTO team_members(team_id, user_id, role, created) VALUES (?, ?, 'owner', ?)").run(id, userId, stamp);
    return readTeam(id)!;
  });
}

/**
 * Creates or updates an operator-provisioned team (for example, an invoiced enterprise account
 * with a domain-restricted join link). Idempotent by team name (case-insensitive).
 */
export function provisionEnterpriseTeam(input: {
  name: unknown;
  ownerEmail?: unknown;
  joinDomain?: unknown;
  planName?: unknown;
  planSpaces?: unknown;
}): Team {
  const name = cleanText(input.name, 80);
  if (!name) throw new AccountError("Enter a team name.");
  const joinDomain = input.joinDomain !== undefined ? normalizeDomain(input.joinDomain) : null;
  const planName = input.planName === null ? null : (cleanText(input.planName, 60) ?? "Enterprise");
  const rawSpaces = input.planSpaces === undefined ? 200 : input.planSpaces;
  const planSpaces = rawSpaces === null || rawSpaces === "" ? null : Number(rawSpaces);
  if (planSpaces !== null && (!Number.isInteger(planSpaces) || planSpaces < 1 || planSpaces > 10000)) {
    throw new AccountError("Enter a valid number of spaces for the team plan.");
  }
  const ownerEmail = typeof input.ownerEmail === "string" && input.ownerEmail.trim() ? input.ownerEmail.trim() : undefined;
  const owner = ownerEmail ? readUserByEmail(ownerEmail) : undefined;
  if (ownerEmail && !owner) throw new AccountError(`No account exists for ${ownerEmail} yet.`);
  return transaction(() => {
    const existing = store().prepare("SELECT * FROM teams WHERE lower(name)=lower(?)").get(name) as TeamRow | undefined;
    if (owner) {
      const memberOf = store().prepare("SELECT team_id FROM team_members WHERE user_id=?").get(owner.id) as { team_id: string } | undefined;
      if (memberOf && memberOf.team_id !== existing?.id) throw new AccountError(`${owner.email} already belongs to another team.`);
    }
    const stamp = now();
    const id = existing?.id ?? randomId(8);
    if (existing) {
      const nextOwnerId = owner?.id ?? existing.owner_id;
      store().prepare("UPDATE teams SET name=?, owner_id=?, join_domain=?, plan_name=?, plan_spaces=?, updated=? WHERE id=?")
        .run(name, nextOwnerId, joinDomain ?? existing.join_domain, planName, planSpaces, stamp, id);
    } else {
      const joinCode = generateJoinCode(name);
      store().prepare("INSERT INTO teams(id, name, owner_id, join_code, join_domain, plan_name, plan_spaces, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, name, owner?.id ?? null, joinCode, joinDomain, planName, planSpaces, stamp, stamp);
    }
    if (owner) {
      store().prepare("UPDATE team_members SET role='member' WHERE team_id=? AND role='owner' AND user_id<>?").run(id, owner.id);
      store().prepare("INSERT INTO team_members(team_id, user_id, role, created) VALUES (?, ?, 'owner', ?) ON CONFLICT(team_id, user_id) DO UPDATE SET role='owner'")
        .run(id, owner.id, stamp);
      if (hostingActive(owner.id)) activateUnpaidSpaces(owner.id);
    }
    return readTeam(id)!;
  });
}

export function joinTeamByCode(userId: string, code: unknown): Team {
  return transaction(() => {
    const user = readUser(userId);
    if (!user) throw new AccountError("Sign in to join this team.");
    const team = readTeamByJoinCode(code);
    if (!team) throw new AccountError("This team invite link is no longer valid.");
    const current = userTeam(userId);
    if (current?.team.id === team.id) return team;
    if (current) throw new AccountError("You are already a member of another team. Leave your current team first.");
    const ownSub = readStoredSubscription(userId);
    if (ownSub && hostingStatuses.has(ownSub.status) && team.ownerId && team.ownerId !== userId) {
      throw new AccountError("Cancel your individual subscription before joining a team.");
    }
    if (team.joinDomain) {
      if (!user.emailVerified) throw new AccountError("Confirm your email address before joining this team.");
      if (emailDomain(user.email) !== team.joinDomain) {
        throw new AccountError(`This invite link is only for @${team.joinDomain} email addresses.`);
      }
    }
    const stamp = now();
    const role: TeamRole = team.ownerId ? "member" : "owner";
    if (!team.ownerId) {
      store().prepare("UPDATE teams SET owner_id=?, updated=? WHERE id=?").run(userId, stamp, team.id);
    } else {
      store().prepare("UPDATE teams SET updated=? WHERE id=?").run(stamp, team.id);
    }
    store().prepare("INSERT INTO team_members(team_id, user_id, role, created) VALUES (?, ?, ?, ?)").run(team.id, userId, role, stamp);
    if (hostingActive(userId)) activateUnpaidSpaces(userId);
    return readTeam(team.id)!;
  });
}

export function updateTeam(
  teamId: string,
  actorUserId: string,
  patch: { name?: unknown; joinDomain?: unknown; regenerateJoinCode?: boolean; planName?: unknown; planSpaces?: unknown },
  isOperator = false,
): Team {
  return transaction(() => {
    const team = readTeam(teamId);
    if (!team) throw new AccountError("Team not found.");
    if (team.ownerId !== actorUserId && !isOperator) throw new AccountError("Only the team owner can update team settings.");
    const nextName = patch.name !== undefined ? cleanText(patch.name, 80) : team.name;
    if (!nextName) throw new AccountError("Enter a team name.");
    const nextDomain = patch.joinDomain !== undefined ? normalizeDomain(patch.joinDomain) : team.joinDomain;
    const nextCode = patch.regenerateJoinCode ? generateJoinCode(nextName) : team.joinCode;
    let nextPlanName = team.planName;
    let nextPlanSpaces = team.planSpaces;
    if (isOperator) {
      if (patch.planName !== undefined) nextPlanName = patch.planName === null || patch.planName === "" ? null : cleanText(patch.planName, 60);
      if (patch.planSpaces !== undefined) {
        const parsed = patch.planSpaces === null || patch.planSpaces === "" ? null : Number(patch.planSpaces);
        if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1 || parsed > 10000)) {
          throw new AccountError("Enter a valid number of spaces for the team plan.");
        }
        nextPlanSpaces = parsed;
      }
    }
    store().prepare("UPDATE teams SET name=?, join_domain=?, join_code=?, plan_name=?, plan_spaces=?, updated=? WHERE id=?")
      .run(nextName, nextDomain, nextCode, nextPlanName, nextPlanSpaces, now(), team.id);
    return readTeam(team.id)!;
  });
}

export function setTeamOwner(teamId: string, actorUserId: string, nextOwnerUserId: string, isOperator = false): Team {
  return transaction(() => {
    const team = readTeam(teamId);
    if (!team) throw new AccountError("Team not found.");
    if (team.ownerId !== actorUserId && !isOperator) throw new AccountError("Only the team owner can transfer ownership.");
    if (!team.members.some(member => member.userId === nextOwnerUserId)) {
      throw new AccountError("Choose a current team member as the new owner.");
    }
    store().prepare("UPDATE team_members SET role='member' WHERE team_id=? AND role='owner'").run(team.id);
    store().prepare("UPDATE team_members SET role='owner' WHERE team_id=? AND user_id=?").run(team.id, nextOwnerUserId);
    store().prepare("UPDATE teams SET owner_id=?, updated=? WHERE id=?").run(nextOwnerUserId, now(), team.id);
    return readTeam(team.id)!;
  });
}

export function removeTeamMember(teamId: string, actorUserId: string, targetUserId: string, isOperator = false): Team | null {
  return transaction(() => {
    const team = readTeam(teamId);
    if (!team) throw new AccountError("Team not found.");
    const isSelf = actorUserId === targetUserId;
    if (!isSelf && team.ownerId !== actorUserId && !isOperator) throw new AccountError("Only the team owner can remove members.");
    const member = team.members.find(item => item.userId === targetUserId);
    if (!member) throw new AccountError("Team member not found.");
    if (member.role === "owner") {
      if (team.members.length > 1) throw new AccountError("Transfer team ownership to another member before leaving the team.");
      if (team.planSpaces !== null) {
        store().prepare("DELETE FROM team_members WHERE team_id=? AND user_id=?").run(team.id, targetUserId);
        store().prepare("UPDATE teams SET owner_id=NULL, updated=? WHERE id=?").run(now(), team.id);
        return readTeam(team.id)!;
      }
      store().prepare("DELETE FROM team_members WHERE team_id=?").run(team.id);
      store().prepare("DELETE FROM teams WHERE id=?").run(team.id);
      return null;
    }
    store().prepare("DELETE FROM team_members WHERE team_id=? AND user_id=?").run(team.id, targetUserId);
    store().prepare("UPDATE teams SET updated=? WHERE id=?").run(now(), team.id);
    return readTeam(team.id)!;
  });
}

// ---- Billing state (Stripe remains the source of truth; this is its latest copy) ----

export const hostingStatuses = new Set(["active", "trialing", "past_due"]);
/** The price a subscription pays. `spaces` is how many spaces a plan covers; null means billed per space. */
export type SubscriptionPlan = { price: string; amount: number | null; currency: string; interval: string; intervalCount: number; spaces: number | null };
/**
 * `cancelAtPeriodEnd` and `cancelAt` (seconds) are Stripe's two ways to schedule a cancellation: at
 * the period's end, or at a date. See `cancellationScheduled` and `cancellationDate`.
 */
export type Subscription = { id: string; item: string | null; status: string; quantity: number; periodEnd: number | null; cancelAtPeriodEnd: boolean;
  cancelAt: number | null; plan: SubscriptionPlan | null };
type SubscriptionRow = { subscription: string; item: string | null; status: string; quantity: number; period_end: number | null; cancel_at_period_end: number;
  cancel_at: number | null; plan: string | null };

/** Whether the subscription is set to end, at the period's end or at a date. */
export function cancellationScheduled(subscription: Subscription) {
  return subscription.cancelAtPeriodEnd || subscription.cancelAt !== null;
}

/** When a scheduled cancellation ends the subscription (seconds), or null when none is scheduled or its date is unknown. */
export function cancellationDate(subscription: Subscription) {
  return subscription.cancelAt ?? (subscription.cancelAtPeriodEnd ? subscription.periodEnd : null);
}

function parsePlan(value: string | null): SubscriptionPlan | null {
  try { return value ? JSON.parse(value) as SubscriptionPlan : null; } catch { return null; }
}

/** Reads the direct Stripe subscription row stored on `userId`, without team inheritance. */
export function readStoredSubscription(userId: string): Subscription | undefined {
  const row = store().prepare("SELECT * FROM subscriptions WHERE user_id=?").get(userId) as SubscriptionRow | undefined;
  return row && { id: row.subscription, item: row.item, status: row.status, quantity: row.quantity, periodEnd: row.period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1, cancelAt: row.cancel_at ?? null, plan: parsePlan(row.plan) };
}

export function readSubscription(userId: string): Subscription | undefined {
  const teamRow = store().prepare(`SELECT teams.id, teams.owner_id, teams.plan_spaces
    FROM team_members JOIN teams ON teams.id = team_members.team_id
    WHERE team_members.user_id=?`).get(userId) as { id: string; owner_id: string | null; plan_spaces: number | null } | undefined;
  if (teamRow) {
    const ownerSub = teamRow.owner_id ? readStoredSubscription(teamRow.owner_id) : undefined;
    if (ownerSub && (hostingStatuses.has(ownerSub.status) || teamRow.plan_spaces === null)) return ownerSub;
    if (teamRow.plan_spaces !== null) {
      return {
        id: `team_${teamRow.id}`,
        item: null,
        status: "active",
        quantity: 1,
        periodEnd: null,
        cancelAtPeriodEnd: false,
        cancelAt: null,
        plan: { price: `team_${teamRow.id}`, amount: null, currency: "usd", interval: "month", intervalCount: 1, spaces: teamRow.plan_spaces },
      };
    }
    return ownerSub;
  }
  return readStoredSubscription(userId);
}

/** How many spaces the customer's plan covers, or null when each space is billed. */
export function planSpaceLimit(userId: string) {
  const subscription = readSubscription(userId);
  return subscription && hostingStatuses.has(subscription.status) ? subscription.plan?.spaces ?? null : null;
}

/** Saves Stripe's latest state and returns what it replaced, read in the same transaction so each change is seen once. */
export function saveSubscription(userId: string, subscription: Subscription) {
  return transaction(() => {
    const current = readStoredSubscription(userId);
    // A late event for an older, ended subscription must not replace a live one.
    if (current && current.id !== subscription.id && hostingStatuses.has(current.status) && !hostingStatuses.has(subscription.status)) return { saved: false, previous: current };
    store().prepare("DELETE FROM subscriptions WHERE subscription=? AND user_id<>?").run(subscription.id, userId);
    store().prepare(`INSERT INTO subscriptions(user_id, subscription, item, status, quantity, period_end, cancel_at_period_end, cancel_at, updated, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      subscription=excluded.subscription, item=excluded.item, status=excluded.status, quantity=excluded.quantity,
      period_end=excluded.period_end, cancel_at_period_end=excluded.cancel_at_period_end, cancel_at=excluded.cancel_at, updated=excluded.updated, plan=excluded.plan`)
      .run(userId, subscription.id, subscription.item, subscription.status, subscription.quantity, subscription.periodEnd,
        Number(subscription.cancelAtPeriodEnd), subscription.cancelAt, now(), subscription.plan ? JSON.stringify(subscription.plan) : null);
    if (hostingStatuses.has(subscription.status)) markPreviewsHosted(teamUserIds(userId));
    return { saved: true, previous: current };
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
/**
 * What a capture is built as: a Gaussian splat, or a tour of 360 panoramas. Null leaves it to the processing
 * agent, which builds a tour from an E57 scan and a splat from everything else.
 */
export type SpaceOutput = "splat" | "tour";
export const spaceOutputs: readonly SpaceOutput[] = ["splat", "tour"];
export type CustomerSpace = { id: string; userId: string; title: string; status: SpaceStatus; sceneId: string | null;
  notes: string | null; output: SpaceOutput | null; message: string | null; created: string; updated: string };
type SpaceRow = { id: string; user_id: string; title: string; status: SpaceStatus; scene_id: string | null; notes: string | null;
  output: string | null; message: string | null; created: string; updated: string };
const billable = "('draft','queued','processing','ready','failed')";
export const maxSpacesPerAccount = 500;

function toSpace(row: SpaceRow): CustomerSpace {
  return { id: row.id, userId: row.user_id, title: row.title, status: row.status, sceneId: row.scene_id, notes: row.notes,
    output: spaceOutputs.includes(row.output as SpaceOutput) ? row.output as SpaceOutput : null,
    message: row.message, created: row.created, updated: row.updated };
}

export function readCustomerSpace(id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{12}$/.test(id)) return undefined;
  const row = store().prepare("SELECT * FROM customer_spaces WHERE id=?").get(id) as SpaceRow | undefined;
  return row ? toSpace(row) : undefined;
}

export function listCustomerSpaces(userId: string) {
  const users = teamUserIds(userId);
  const marks = users.map(() => "?").join(",");
  return (store().prepare(`SELECT * FROM customer_spaces WHERE user_id IN (${marks}) AND status<>'deleted' ORDER BY created DESC`).all(...users) as SpaceRow[]).map(toSpace);
}

export function spaceForScene(sceneId: string) {
  const row = store().prepare("SELECT * FROM customer_spaces WHERE scene_id=?").get(sceneId) as SpaceRow | undefined;
  return row ? toSpace(row) : undefined;
}

/** A space the customer's plan does not cover; the customer can change plans to add it. */
export class PlanLimitError extends AccountError {}

/** The account's free preview is already spent on another space. */
export class PreviewUsedError extends AccountError {}

/** `preview` spends the account's one free preview on the new space, which then opens for files without payment. */
export function createCustomerSpace(userId: string, title: string, status: "unpaid" | "draft", planSpaces: number | null = null, preview = false) {
  return transaction(() => {
    const users = teamUserIds(userId);
    const marks = users.map(() => "?").join(",");
    const { count } = store().prepare(`SELECT count(*) AS count FROM customer_spaces WHERE user_id IN (${marks}) AND status<>'deleted'`).get(...users) as { count: number };
    const limit = Math.max(maxSpacesPerAccount, planSpaces ?? 0);
    if (count >= limit) {
      const contact = contactEmail();
      throw new AccountError(`This account has reached its space limit. ${contact ? `Write to ${contact}` : "Contact support"} to add more.`);
    }
    if (planSpaces !== null && count >= planSpaces) {
      throw new PlanLimitError(`Your plan covers ${planSpaces} ${planSpaces === 1 ? "space" : "spaces"}. Change plans to add another.`);
    }
    if (status === "unpaid") {
      const { waiting } = store().prepare(`SELECT count(*) AS waiting FROM customer_spaces WHERE user_id IN (${marks}) AND status='unpaid'`).get(...users) as { waiting: number };
      if (waiting >= 10) throw new AccountError("Complete payment for your existing spaces first.");
    }
    const id = randomId(6);
    const stamp = now();
    store().prepare("INSERT INTO customer_spaces(id, user_id, title, status, created, updated) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, title, status, stamp, stamp);
    // Thrown inside the transaction, so a lost race leaves no space behind.
    if (preview && !claimPreview(userId, id)) throw new PreviewUsedError("Your free preview is already used.");
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
    // A preview deleted before anything was submitted cost no agent time, so its owner keeps the preview.
    if (!store().prepare("SELECT 1 FROM jobs WHERE space_id=?").get(id)) store().prepare("UPDATE preview_grants SET space_id=NULL, ready=NULL WHERE space_id=?").run(id);
  });
}

/** Published listings of hosted customer spaces. They are kept out of the shared public catalog. */
export function readCustomerListings(): unknown[] {
  return (store().prepare("SELECT listing FROM customer_spaces WHERE listing IS NOT NULL AND status<>'deleted'").all() as { listing: string }[])
    .map(row => JSON.parse(row.listing));
}

export function billableSpaceCount(userId: string) {
  const users = teamUserIds(userId);
  const marks = users.map(() => "?").join(",");
  return (store().prepare(`SELECT count(*) AS count FROM customer_spaces WHERE user_id IN (${marks}) AND status IN ${billable}`).get(...users) as { count: number }).count;
}

/** Spaces a new subscription must cover: everything the customer has not deleted. */
export function payableSpaceCount(userId: string) {
  const users = teamUserIds(userId);
  const marks = users.map(() => "?").join(",");
  return (store().prepare(`SELECT count(*) AS count FROM customer_spaces WHERE user_id IN (${marks}) AND status<>'deleted'`).get(...users) as { count: number }).count;
}

export function activateUnpaidSpaces(userId: string) {
  const users = teamUserIds(userId);
  const marks = users.map(() => "?").join(",");
  store().prepare(`UPDATE customer_spaces SET status='draft', updated=? WHERE user_id IN (${marks}) AND status='unpaid'`).run(now(), ...users);
}

// ---- Free previews ----
// Each account sees one capture processed before it pays. The space is an ordinary draft space; the grant
// marks it, and the space stays private until hosting starts. The grant outlives the space, so deleting and
// adding again earns no second one. The window starts when the first result is ready and ends `previewDays` later
// (lib/server/previews.ts). The operator can approve a bigger preview by setting max_files and max_bytes on an
// account's row, even before it has used its preview (space_id NULL).

export type PreviewGrant = { userId: string; spaceId: string | null; granted: string; ready: string | null; maxFiles: number | null;
  maxBytes: number | null; note: string | null; hosted: string | null };
type PreviewRow = { user_id: string; space_id: string | null; granted: string; ready: string | null; max_files: number | null; max_bytes: number | null; note: string | null;
  hosted: string | null };
const toPreviewGrant = (row: PreviewRow): PreviewGrant => ({ userId: row.user_id, spaceId: row.space_id, granted: row.granted, ready: row.ready,
  maxFiles: row.max_files, maxBytes: row.max_bytes, note: row.note, hosted: row.hosted });

/** Hosting has started for these accounts: their previews are ordinary spaces from then on, even if billing ends again later. */
export function markPreviewsHosted(userIds: string[]) {
  const marks = userIds.map(() => "?").join(",");
  store().prepare(`UPDATE preview_grants SET hosted=? WHERE hosted IS NULL AND space_id IS NOT NULL AND user_id IN (${marks})`).run(now(), ...userIds);
}

/** The account's grant: spent on a space, or approved by the operator and not spent yet. */
export function readPreviewGrant(userId: string) {
  const row = store().prepare("SELECT * FROM preview_grants WHERE user_id=?").get(userId) as PreviewRow | undefined;
  return row ? toPreviewGrant(row) : undefined;
}

/** The grant spent on this space, if it is a free preview. */
export function readSpacePreview(spaceId: string) {
  const row = store().prepare("SELECT * FROM preview_grants WHERE space_id=?").get(spaceId) as PreviewRow | undefined;
  return row ? toPreviewGrant(row) : undefined;
}

/** Spends the account's grant on a space; false when it is already spent. */
function claimPreview(userId: string, spaceId: string) {
  return store().prepare(`INSERT INTO preview_grants(user_id, space_id, granted) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET space_id=excluded.space_id, granted=excluded.granted WHERE preview_grants.space_id IS NULL`)
    .run(userId, spaceId, now()).changes === 1;
}

/** Turns a space that waits for payment into the account's free preview, so files can upload at once. */
export function convertToPreview(spaceId: string, userId: string) {
  return transaction(() => {
    const space = readCustomerSpace(spaceId);
    if (!space || space.status !== "unpaid") throw new AccountError("This space is not waiting for payment.");
    if (!claimPreview(userId, space.id)) throw new PreviewUsedError("Your free preview is already used.");
    store().prepare("UPDATE customer_spaces SET status='draft', updated=? WHERE id=?").run(now(), space.id);
    return readCustomerSpace(space.id)!;
  });
}

/** Previews started since a time, for the day's budget. A preview given back is not counted. */
export function countPreviewsSince(since: string) {
  return (store().prepare("SELECT count(*) AS count FROM preview_grants WHERE space_id IS NOT NULL AND granted >= ?").get(since) as { count: number }).count;
}

/** Agent runs a space has used or is waiting for. Jobs held for an operator are not the customer's. */
export function previewRuns(spaceId: string) {
  return (store().prepare("SELECT count(*) AS count FROM jobs WHERE space_id=? AND status IN ('queued','running','done','failed')").get(spaceId) as { count: number }).count;
}

// ---- Uploads ----

export type UploadStatus = "uploading" | "complete" | "deleted";
export type Upload = { id: string; spaceId: string; name: string; size: number; type: string; object: string; session: string | null; status: UploadStatus; created: string };
type UploadRow = { id: string; space_id: string; name: string; size: number; type: string; object: string; session: string | null; status: UploadStatus; created: string };
const toUpload = (row: UploadRow): Upload => ({ id: row.id, spaceId: row.space_id, name: row.name, size: row.size, type: row.type,
  object: row.object, session: row.session, status: row.status, created: row.created });
export const maxUploadsPerSpace = 2000;

/** A free preview holds fewer files than a hosted space does; hosting lifts the limit. */
export class PreviewLimitError extends AccountError {}

export function createUploadRecord(spaceId: string, name: string, size: number, type: string, objectFor: (id: string) => string, maxBytes: number,
  preview?: { files: number; bytes: number }) {
  return transaction(() => {
    const totals = store().prepare("SELECT count(*) AS count, coalesce(sum(size), 0) AS bytes FROM uploads WHERE space_id=? AND status<>'deleted'")
      .get(spaceId) as { count: number; bytes: number };
    if (preview && totals.count >= preview.files) throw new PreviewLimitError(`A free preview holds up to ${preview.files} files.`);
    if (preview && totals.bytes + size > preview.bytes) throw new PreviewLimitError(`A free preview holds up to ${formatBytes(preview.bytes)}.`);
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
  progress: string | null; created: string; started: string | null; finished: string | null; preview: boolean };
type JobRow = { id: string; space_id: string; scene_id: string; status: JobStatus; attempts: number; worker: string | null; message: string | null;
  progress: string | null; created: string; started: string | null; finished: string | null; preview: number };
const toJob = (row: JobRow): Job => ({ id: row.id, spaceId: row.space_id, sceneId: row.scene_id, status: row.status, attempts: row.attempts,
  worker: row.worker, message: row.message, progress: row.progress, created: row.created, started: row.started, finished: row.finished, preview: row.preview === 1 });
export const maxJobAttempts = 3;
/**
 * Shown on a space whose job waits for an operator, so the customer sees a reason rather than endless processing.
 * A person looks at every held job and the cause is often on our side, so the customer is not sent to change files
 * that may be fine. Files that cannot become a space are reported with the agent's own message instead (`fail`).
 */
export function heldSpaceMessage() {
  const contact = contactEmail();
  return "We couldn't finish building this space automatically, so a person will look at it. Your files are still here and you don't need "
    + `to do anything yet. We'll email you once it's sorted${contact ? `, or write to ${contact} with any questions` : ""}.`;
}

/** Shown on a space whose worker stopped answering on every attempt: our failure, not the customer's files. */
export function stalledSpaceMessage() {
  const contact = contactEmail();
  return `Our processing stopped before this space was finished. The problem was on our side, not with your files, and we are looking into it. `
    + `You can start processing again from the space page${contact ? `, or write to ${contact}` : ""}.`;
}

function unusedSceneId() {
  for (;;) {
    const id = randomId(6);
    const taken = store().prepare("SELECT 1 FROM customer_spaces WHERE scene_id=? UNION SELECT 1 FROM jobs WHERE scene_id=?").get(id, id);
    if (!taken) return id;
  }
}

/** Reads a requested output: a choice, null for "let the agent decide", or undefined to keep the space's last choice. */
export function parseSpaceOutput(value: unknown): SpaceOutput | null | undefined {
  if (value === "auto" || value === null) return null;
  return spaceOutputs.includes(value as SpaceOutput) ? value as SpaceOutput : undefined;
}

export function submitCustomerSpace(spaceId: string, notes: string | null, output?: SpaceOutput | null) {
  return transaction(() => {
    const space = readCustomerSpace(spaceId);
    if (!space || !["draft", "failed", "ready"].includes(space.status)) throw new AccountError("This space cannot be submitted right now.");
    const uploads = listUploads(spaceId);
    if (!uploads.some(upload => upload.status === "complete")) throw new AccountError("Upload at least one file first.");
    if (uploads.some(upload => upload.status === "uploading")) throw new AccountError("Wait for every upload to finish, or remove unfinished files.");
    const id = randomId(8);
    // A new submission replaces earlier attempts that wait for an operator; releasing one later would
    // overwrite whatever the new job builds.
    store().prepare("UPDATE jobs SET status='canceled', message='Replaced by a new submission. ' || COALESCE(message, ''), finished=? WHERE space_id=? AND status='held'")
      .run(now(), spaceId);
    // The scene ID is fixed before processing so a job can only publish its own space.
    // Jobs of free previews wait behind jobs of hosted spaces, so a flood of previews never delays a customer who pays.
    const preview = Boolean(readSpacePreview(spaceId)) && !hostingActive(space.userId);
    store().prepare("INSERT INTO jobs(id, space_id, scene_id, status, preview, created) VALUES (?, ?, ?, 'queued', ?, ?)")
      .run(id, spaceId, space.sceneId ?? unusedSceneId(), Number(preview), now());
    store().prepare("UPDATE customer_spaces SET status='queued', notes=?, output=?, message=NULL, updated=? WHERE id=?")
      .run(notes, output === undefined ? space.output : output, now(), spaceId);
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
  return (store().prepare(`SELECT * FROM jobs WHERE status IN (${marks}) ORDER BY preview, created`).all(...statuses) as JobRow[]).map(toJob);
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
    // A held job may have moved its space to failed; requeueing brings it back into the pipeline.
    store().prepare("UPDATE customer_spaces SET status='queued', message=NULL, updated=? WHERE id=? AND status IN ('processing','failed')").run(now(), job.spaceId);
    return true;
  });
}

/**
 * Returns a running job whose worker could not start its agent (a missing image, a broken sandbox) to the
 * queue. The problem is ours, so the attempt is given back and the customer's space keeps waiting.
 */
export function deferJob(id: string) {
  return transaction(() => {
    const job = readJob(id);
    if (!job || job.status !== "running") return false;
    store().prepare("UPDATE jobs SET status='queued', worker=NULL, started=NULL, progress=NULL, attempts=MAX(attempts-1, 0) WHERE id=?").run(id);
    store().prepare("UPDATE customer_spaces SET status='queued', updated=? WHERE id=? AND status='processing'").run(now(), job.spaceId);
    return true;
  });
}

/** The latest step the processing agent reported, shown to the customer while it works. */
export function setJobProgress(id: string, progress: string) {
  return store().prepare("UPDATE jobs SET progress=? WHERE id=? AND status='running'").run(progress, id).changes > 0;
}

/**
 * Parks a running job for an operator. The job waits in 'held' for a human, but the space is
 * moved out of processing to a failed state so the customer sees a reason instead of a spinner
 * that never resolves. Returns the space and whether it just transitioned, for notifications.
 */
export function holdJob(id: string, message: string | null) {
  return transaction(() => {
    const job = readJob(id);
    if (!job || job.status !== "running") return null;
    store().prepare("UPDATE jobs SET status='held', message=? WHERE id=?").run(message, id);
    const before = readCustomerSpace(job.spaceId)!;
    const transitioned = before.status === "processing" || before.status === "queued";
    if (transitioned) {
      store().prepare("UPDATE customer_spaces SET status='failed', message=?, updated=? WHERE id=?").run(heldSpaceMessage(), now(), job.spaceId);
    }
    return { space: readCustomerSpace(job.spaceId)!, transitioned };
  });
}

/**
 * A crashed or stalled worker leaves its job running. After the lease, the job returns to
 * the queue, or waits for an operator once it has used every attempt. Returns the jobs that
 * gave up and the spaces they moved out of processing, each once: a held job is not swept again.
 */
export function expireJobLeases(hours: number) {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  return transaction(() => {
    const stale = store().prepare("SELECT * FROM jobs WHERE status='running' AND started < ?").all(cutoff) as JobRow[];
    const stopped: { job: Job; space: CustomerSpace }[] = [];
    for (const job of stale) {
      if (job.attempts >= maxJobAttempts) {
        store().prepare("UPDATE jobs SET status='held', message=? WHERE id=?").run(`Stopped after ${job.attempts} attempts without a result.`, job.id);
        // Don't leave the customer's space processing forever once the job has given up.
        const moved = store().prepare("UPDATE customer_spaces SET status='failed', message=?, updated=? WHERE id=? AND status IN ('processing','queued')")
          .run(stalledSpaceMessage(), now(), job.space_id).changes > 0;
        if (moved) stopped.push({ job: readJob(job.id)!, space: readCustomerSpace(job.space_id)! });
      } else {
        store().prepare("UPDATE jobs SET status='queued', worker=NULL, started=NULL WHERE id=?").run(job.id);
        store().prepare("UPDATE customer_spaces SET status='queued', updated=? WHERE id=? AND status='processing'").run(now(), job.space_id);
      }
    }
    return stopped;
  });
}

export function finishJob(id: string, outcome: { ok: true; message: string | null; listing: object } | { ok: false; message: string }) {
  return transaction(() => {
    const job = readJob(id);
    if (!job || (job.status !== "running" && job.status !== "held")) throw new AccountError("This job is not running.");
    const space = readCustomerSpace(job.spaceId)!;
    if (space.status === "deleted") {
      store().prepare("UPDATE jobs SET status='canceled', message=?, finished=? WHERE id=?").run(outcome.message, now(), id);
      return { job: readJob(id)!, space, previousSceneId: null, previewStarted: false };
    }
    store().prepare("UPDATE jobs SET status=?, message=?, finished=? WHERE id=?").run(outcome.ok ? "done" : "failed", outcome.message, now(), id);
    let previewStarted = false;
    if (outcome.ok) {
      store().prepare("UPDATE customer_spaces SET status='ready', scene_id=?, listing=?, message=?, updated=? WHERE id=?")
        .run(job.sceneId, JSON.stringify(outcome.listing), outcome.message, now(), space.id);
      // A free preview's window starts with its first result, not when it was made or queued.
      previewStarted = store().prepare("UPDATE preview_grants SET ready=? WHERE space_id=? AND ready IS NULL").run(now(), space.id).changes === 1;
    } else {
      store().prepare("UPDATE customer_spaces SET status='failed', message=?, updated=? WHERE id=?").run(outcome.message, now(), space.id);
    }
    return { job: readJob(id)!, space: readCustomerSpace(space.id)!, previousSceneId: space.sceneId !== job.sceneId ? space.sceneId : null, previewStarted };
  });
}
