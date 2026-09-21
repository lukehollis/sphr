import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { SceneEdits, StartView } from "../scene-edits";

const scrypt = promisify(scryptCallback);
const lifetime = 8 * 60 * 60 * 1000;
let database: DatabaseSync | undefined;

export function accessControlled() { return process.env.SPHR_ACCESS_CONTROL === "1"; }

function db() {
  if (database) return database;
  const directory = process.env.SPHR_STATE_DIR;
  if (!directory) throw new Error("SPHR_STATE_DIR must be configured for administration.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, "admin.sqlite");
  database = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS visibility (scene TEXT PRIMARY KEY, public INTEGER NOT NULL CHECK(public IN (0,1)));
    CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, resets INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, scene TEXT NOT NULL, public INTEGER NOT NULL, changed TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scene_edits (scene TEXT PRIMARY KEY, title TEXT, start_view TEXT, thumbnail BLOB, thumbnail_version TEXT, revision INTEGER NOT NULL, changed TEXT NOT NULL);
  `);
  return database;
}

type EditRow = { scene: string; title: string | null; start_view: string | null; thumbnail_version: string | null; revision: number };
function editsFromRow(row: EditRow): SceneEdits {
  return { title: row.title, startView: row.start_view ? JSON.parse(row.start_view) : null,
    thumbnailVersion: row.thumbnail_version, revision: row.revision };
}
export function readSceneEdits(): Map<string, SceneEdits> {
  if (!process.env.SPHR_STATE_DIR) return new Map();
  const rows = db().prepare('SELECT scene, title, start_view, thumbnail_version, revision FROM scene_edits').all() as EditRow[];
  return new Map(rows.map(row => [row.scene, editsFromRow(row)]));
}

export class EditConflict extends Error {}
export function saveSceneEdits(scene: string, revision: number, title: string | null,
  capture?: { view: StartView; thumbnail: Buffer } | null) {
  if (!/^[a-f0-9]{12}$/.test(scene) || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid edit.');
  const connection = db();
  connection.exec('BEGIN IMMEDIATE');
  try {
    const row = connection.prepare('SELECT revision FROM scene_edits WHERE scene=?').get(scene) as { revision: number } | undefined;
    if ((row?.revision ?? 0) !== revision) throw new EditConflict('This space was edited elsewhere. Reload before saving.');
    connection.prepare(`INSERT INTO scene_edits(scene, title, revision, changed) VALUES (?, ?, ?, ?)
      ON CONFLICT(scene) DO UPDATE SET title=excluded.title, revision=excluded.revision, changed=excluded.changed`)
      .run(scene, title, revision + 1, new Date().toISOString());
    if (capture !== undefined) {
      connection.prepare('UPDATE scene_edits SET start_view=?, thumbnail=?, thumbnail_version=? WHERE scene=?').run(
        capture ? JSON.stringify(capture.view) : null, capture?.thumbnail ?? null,
        capture ? createHash('sha256').update(capture.thumbnail).digest('hex').slice(0, 16) : null, scene);
    }
    connection.exec('COMMIT');
  } catch (error) { connection.exec('ROLLBACK'); throw error; }
  return readSceneEdits().get(scene)!;
}

export function readSceneThumbnail(scene: string): Uint8Array | undefined {
  if (!process.env.SPHR_STATE_DIR) return undefined;
  return (db().prepare('SELECT thumbnail FROM scene_edits WHERE scene=?').get(scene) as { thumbnail: Uint8Array | null } | undefined)?.thumbnail ?? undefined;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(32).toString("hex");
  const key = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [salt, digest] = stored.split(":");
  if (!/^[a-f0-9]{64}$/.test(salt) || !/^[a-f0-9]{128}$/.test(digest)) return false;
  const candidate = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(candidate, Buffer.from(digest, "hex"));
}

export async function initializeAdmin(username: string, password: string) {
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(username) || password.length < 8 || password.length > 256) throw new Error("Invalid admin credentials.");
  const hash = await hashPassword(password);
  db().prepare("INSERT INTO admin(id, username, password) VALUES (1, ?, ?)").run(username, hash);
}

export async function checkCredentials(username: string, password: string) {
  const admin = db().prepare("SELECT username, password FROM admin WHERE id=1").get() as { username: string; password: string } | undefined;
  // Keep password work independent of the supplied username.
  const valid = await verifyPassword(password, admin?.password ?? `${"0".repeat(64)}:${"0".repeat(128)}`);
  return Boolean(admin && username === admin.username && valid);
}

function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }

export function createSession() {
  db().prepare("DELETE FROM sessions WHERE expires <= ?").run(Date.now());
  const token = randomBytes(32).toString("hex");
  db().prepare("INSERT INTO sessions(token, expires) VALUES (?, ?)").run(tokenHash(token), Date.now() + lifetime);
  return { token, maxAge: lifetime / 1000 };
}

export function validSession(token: string | undefined) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  return Boolean(db().prepare("SELECT token FROM sessions WHERE token=? AND expires>?").get(tokenHash(token), Date.now()));
}

export function deleteSession(token: string | undefined) {
  if (token) db().prepare("DELETE FROM sessions WHERE token=?").run(tokenHash(token));
}

export async function changePassword(current: string, replacement: string) {
  const admin = db().prepare("SELECT password FROM admin WHERE id=1").get() as { password: string } | undefined;
  if (!admin || !(await verifyPassword(current, admin.password))) return false;
  const hash = await hashPassword(replacement);
  db().exec("BEGIN IMMEDIATE");
  try {
    const result = db().prepare("UPDATE admin SET password=? WHERE id=1 AND password=?").run(hash, admin.password);
    if (!result.changes) { db().exec("ROLLBACK"); return false; }
    db().exec("DELETE FROM sessions; COMMIT;");
    return true;
  } catch (error) { db().exec("ROLLBACK"); throw error; }
}

export function allowLogin(address: string) {
  const now = Date.now();
  const entries = [[`ip:${tokenHash(address)}`, 5], ["global", 100]] as const;
  db().exec("BEGIN IMMEDIATE");
  try {
    db().prepare("DELETE FROM login_limits WHERE resets<=?").run(now);
    for (const [key, limit] of entries) {
      const row = db().prepare("SELECT attempts FROM login_limits WHERE key=?").get(key) as { attempts: number } | undefined;
      if (row && row.attempts >= limit) { db().exec("COMMIT"); return false; }
    }
    for (const [key] of entries) db().prepare("INSERT INTO login_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1").run(key, now + 15 * 60 * 1000);
    db().exec("COMMIT");
    return true;
  } catch (error) { db().exec("ROLLBACK"); throw error; }
}

export function isScenePublic(scene: string) {
  if (!accessControlled()) return true;
  return (db().prepare("SELECT public FROM visibility WHERE scene=?").get(scene) as { public: number } | undefined)?.public === 1;
}

export function setScenePublic(scene: string, value: boolean) {
  if (!/^[a-f0-9]{12}$/.test(scene) || typeof value !== "boolean") throw new Error("Invalid visibility setting.");
  db().exec("BEGIN IMMEDIATE");
  try {
    db().prepare("INSERT INTO visibility VALUES (?, ?) ON CONFLICT(scene) DO UPDATE SET public=excluded.public").run(scene, Number(value));
    db().prepare("INSERT INTO audit(scene, public, changed) VALUES (?, ?, ?)").run(scene, Number(value), new Date().toISOString());
    db().exec("DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 1000); COMMIT;");
  } catch (error) { db().exec("ROLLBACK"); throw error; }
}
