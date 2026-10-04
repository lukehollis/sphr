import { randomBytes } from "node:crypto";
import { db, EditConflict, isScenePublic } from "./admin-store";
import { spaceForScene } from "./accounts-store";
import { accountRequest, accountResponse, accountsEnabled, bearerToken, currentUser, requestUser, sameOrigin, spaceHosted } from "./accounts";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isAdmin } from "./auth";
import { readAllScenes } from "@/lib/scene-catalog";
import { parseExperience } from "@/lib/experience/validate";
import type { Experience, ExperienceKind } from "@/lib/experience/types";
import type { SceneListing } from "@/lib/scene-types";
import { sceneTitleSlug } from "@/lib/scene-edits";

/**
 * Customers' own guided tours and scavenger hunts. Each one is built on a space, either
 * one of the customer's hosted spaces or one of the operator's public spaces, and has
 * its own link. The space itself is never changed, and a tour does not count as a space.
 */
export type UserTour = { id: string; userId: string; sceneId: string; title: string; kind: ExperienceKind; experience: Experience | null;
  public: boolean; revision: number; created: string; updated: string };
type TourRow = { id: string; user_id: string; scene_id: string; title: string; kind: string; experience: string | null;
  public: number; revision: number; created: string; updated: string };

export const maxToursPerAccount = 200;
let prepared = false;

function store() {
  const connection = db();
  if (prepared) return connection;
  connection.exec(`
    CREATE TABLE IF NOT EXISTS user_tours (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scene_id TEXT NOT NULL, title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('tour','hunt')), experience TEXT, public INTEGER NOT NULL DEFAULT 0 CHECK(public IN (0,1)),
      revision INTEGER NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS user_tours_user ON user_tours(user_id);
  `);
  prepared = true;
  return connection;
}

function toTour(row: TourRow): UserTour {
  let experience: Experience | null = null;
  if (row.experience) {
    try { experience = parseExperience(JSON.parse(row.experience), { lenient: true }); }
    catch (error) { console.error(`Ignoring an unreadable tour ${row.id}:`, error instanceof Error ? error.message : error); }
  }
  return { id: row.id, userId: row.user_id, sceneId: row.scene_id, title: row.title, kind: row.kind === "hunt" ? "hunt" : "tour",
    experience, public: row.public === 1, revision: row.revision, created: row.created, updated: row.updated };
}

export function readUserTour(id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{12}$/.test(id)) return undefined;
  const row = store().prepare("SELECT * FROM user_tours WHERE id=?").get(id) as TourRow | undefined;
  return row ? toTour(row) : undefined;
}

export function listUserTours(userId: string) {
  return (store().prepare("SELECT * FROM user_tours WHERE user_id=? ORDER BY updated DESC").all(userId) as TourRow[]).map(toTour);
}

export function createUserTour(userId: string, sceneId: string, title: string, kind: ExperienceKind) {
  const connection = store();
  connection.exec("BEGIN IMMEDIATE");
  try {
    const { count } = connection.prepare("SELECT count(*) AS count FROM user_tours WHERE user_id=?").get(userId) as { count: number };
    if (count >= maxToursPerAccount) throw new TourLimitError(`An account can keep up to ${maxToursPerAccount} tours. Delete one to make another.`);
    let id: string;
    do id = randomBytes(6).toString("hex"); while (connection.prepare("SELECT 1 FROM user_tours WHERE id=?").get(id));
    const stamp = new Date().toISOString();
    connection.prepare("INSERT INTO user_tours(id, user_id, scene_id, title, kind, experience, public, revision, created, updated) VALUES (?, ?, ?, ?, ?, NULL, 0, 0, ?, ?)")
      .run(id, userId, sceneId, title, kind, stamp, stamp);
    connection.exec("COMMIT");
    return readUserTour(id)!;
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
}

/** Save a tour's content, title and sharing together, refusing stale revisions. */
export function saveUserTour(id: string, revision: number, update: { experience: Experience; title: string; public: boolean }) {
  const connection = store();
  connection.exec("BEGIN IMMEDIATE");
  try {
    const row = connection.prepare("SELECT revision FROM user_tours WHERE id=?").get(id) as { revision: number } | undefined;
    if (!row) throw new Error("Tour not found.");
    if (row.revision !== revision) throw new EditConflict("This tour was edited elsewhere. Reload before saving.");
    connection.prepare("UPDATE user_tours SET experience=?, title=?, kind=?, public=?, revision=?, updated=? WHERE id=?")
      .run(JSON.stringify(update.experience), update.title, update.experience.kind, Number(update.public), revision + 1, new Date().toISOString(), id);
    connection.exec("COMMIT");
    return readUserTour(id)!;
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
}

export function deleteUserTour(id: string) {
  store().prepare("DELETE FROM user_tours WHERE id=?").run(id);
  deleteTourModels(id);
}

export class TourLimitError extends Error {}

export function tourPath(tour: Pick<UserTour, "id" | "title">) {
  return `/t/${tour.id}/${sceneTitleSlug(tour.title)}`;
}

/** Matterport embeds have no capture of their own to place objects in. */
export function buildableScene(scene: SceneListing) {
  return scene.sourceType !== "matterport" && !(scene.nodeCount === 0 && scene.sourceType === "spaces");
}

/**
 * Whether a customer may build on a space: one of their own hosted, finished spaces, or
 * one of the operator's public spaces. Another customer's space is never offered, even
 * a public one.
 */
export function canBuildOn(userId: string, scene: SceneListing) {
  if (!buildableScene(scene)) return false;
  const owned = spaceForScene(scene.sceneId);
  if (owned) return owned.userId === userId && owned.status === "ready" && spaceHosted(owned);
  return isScenePublic(scene.sceneId);
}

/** Whether a space is one of the operator's own rather than a customer's. */
export function isOperatorScene(sceneId: string) {
  return !spaceForScene(sceneId);
}

export async function tourScene(tour: Pick<UserTour, "sceneId">) {
  return (await readAllScenes()).find(scene => scene.sceneId === tour.sceneId);
}

/**
 * Who may watch a tour: its owner and anyone with the link once it is shared, for as long
 * as its owner may still build on the space. The operator can always open it to help.
 */
export async function tourAccess(tour: UserTour): Promise<"allowed" | "login" | "unavailable"> {
  if (await isAdmin()) return "allowed";
  const scene = await tourScene(tour);
  if (!scene || !canBuildOn(tour.userId, scene)) return "unavailable";
  const user = await currentUser();
  if (tour.public || user?.id === tour.userId) return "allowed";
  return user ? "unavailable" : "login";
}

/**
 * Reads a request from a tour's owner: the body, the tour and the space it is built on, or
 * the error response. With `anySpace`, a tour whose space is gone is still returned.
 */
export async function ownedTourRequest(request: Request, id: string, maxBytes: number,
  { anySpace = false, body: kind = "json", agents = true }: { anySpace?: boolean; body?: "json" | "none"; agents?: boolean } = {}) {
  // People's own agents use these routes with their linked token, as with spaces (deleting excepted).
  const { user, body, error } = kind === "json" ? await accountRequest(request, maxBytes, { agents }) : await tourUser(request);
  if (error) return { error } as const;
  const tour = readUserTour(id);
  if (!tour || tour.userId !== user.id) return { error: accountResponse({ error: "Tour not found." }, 404) } as const;
  const scene = await tourScene(tour);
  if (!anySpace && (!scene || !canBuildOn(user.id, scene))) {
    return { error: accountResponse({ error: "This tour's space is no longer available to build on." }, 410) } as const;
  }
  return { user, body, tour, scene } as const;
}

/**
 * The signed-in customer, or a linked agent's customer, for requests without a JSON
 * body (reads, and model uploads). Browser requests that change something must come
 * from this site.
 */
export async function tourUser(request: Request) {
  if (!accountsEnabled()) return { error: accountResponse({ error: "Accounts are unavailable." }, 404) } as const;
  const agent = bearerToken(request) !== undefined;
  if (!agent && request.method !== "GET" && !sameOrigin(request)) return { error: accountResponse({ error: "Invalid request." }, 400) } as const;
  const user = await requestUser(request, true);
  if (!user) return { error: accountResponse({ error: agent ? "This agent is no longer linked. Link it again." : "Sign in to continue." }, 401) } as const;
  return { user, body: null, agent } as const;
}

// Models a customer brings to a tour (for example made in Blender): validated glTF binaries,
// kept with the application state and served from this site.
export const maxModelBytes = 25 * 1024 * 1024;
const maxModelsPerTour = 20;
const tourFiles = (tourId: string) => path.join(process.env.SPHR_STATE_DIR ?? "", "tour-files", tourId);

export class ModelError extends Error {}

/**
 * Checks a glTF binary: the GLB header, a JSON chunk, and no external files
 * (every buffer and image must be inside the GLB or a data URI).
 */
export function checkGlb(bytes: Buffer) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) throw new ModelError("That is not a GLB file. Export glTF Binary (.glb).");
  if (bytes.readUInt32LE(4) !== 2) throw new ModelError("Only glTF 2.0 GLB files are supported.");
  if (bytes.readUInt32LE(8) !== bytes.length) throw new ModelError("The GLB file is incomplete.");
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLength > bytes.length) throw new ModelError("The GLB file has no glTF JSON.");
  let gltf: { buffers?: { uri?: string }[]; images?: { uri?: string }[]; meshes?: unknown[] };
  try { gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")); } catch { throw new ModelError("The GLB file's glTF JSON is unreadable."); }
  const external = [...(gltf.buffers ?? []), ...(gltf.images ?? [])].some((item) => typeof item?.uri === "string" && !item.uri.startsWith("data:"));
  if (external) throw new ModelError("The model refers to files outside the GLB. Export with everything embedded.");
  if (!gltf.meshes?.length) throw new ModelError("The GLB file has no meshes.");
}

/** Keeps a model for a tour and returns the address to use as its source url. */
export function saveTourModel(tourId: string, bytes: Buffer) {
  checkGlb(bytes);
  const folder = tourFiles(tourId);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.glb`;
  const existing = readdirSync(folder).filter((file) => file.endsWith(".glb"));
  if (!existing.includes(name) && existing.length >= maxModelsPerTour) throw new ModelError(`A tour can hold up to ${maxModelsPerTour} uploaded models.`);
  writeFileSync(path.join(folder, name), bytes, { mode: 0o600 });
  return `/api/tour-files/${tourId}/${name}`;
}

export function tourModelFile(tourId: string, name: string) {
  if (!/^[a-f0-9]{12}$/.test(tourId) || !/^[a-f0-9]{16}\.glb$/.test(name) || !process.env.SPHR_STATE_DIR) return null;
  const file = path.join(tourFiles(tourId), name);
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}

export function deleteTourModels(tourId: string) {
  if (/^[a-f0-9]{12}$/.test(tourId) && process.env.SPHR_STATE_DIR) rmSync(tourFiles(tourId), { recursive: true, force: true });
}

/** The customer's tours for the account page, newest edits first. */
export async function describeTours(userId: string) {
  const scenes = new Map((await readAllScenes()).map(scene => [scene.sceneId, scene]));
  return listUserTours(userId).map(tour => {
    const scene = scenes.get(tour.sceneId);
    return { id: tour.id, title: tour.title, kind: tour.kind, public: tour.public, stops: tour.experience?.stops.length ?? 0, updated: tour.updated,
      path: tourPath(tour), editor: `/account/tours/${tour.id}`, available: Boolean(scene && canBuildOn(userId, scene)),
      space: scene ? { title: scene.title, thumbnail: scene.thumbnail, spacery: isOperatorScene(scene.sceneId) } : null };
  });
}
export type TourView = Awaited<ReturnType<typeof describeTours>>[number];

export type PickerSpace = { sceneId: string; title: string; thumbnail: string; nodeCount: number; guided: boolean; createdAt: string; sourceType?: string };

/** The spaces a customer can build on: their own finished spaces, and the operator's public ones. */
export async function buildableSpaces(userId: string) {
  const own: PickerSpace[] = [];
  const spacery: PickerSpace[] = [];
  for (const scene of await readAllScenes()) {
    if (!canBuildOn(userId, scene)) continue;
    const item = { sceneId: scene.sceneId, title: scene.title, thumbnail: scene.thumbnail, nodeCount: scene.nodeCount, sourceType: scene.sourceType,
      guided: scene.hasGuidedTour ?? scene.legacy?.kind === "tour", createdAt: scene.createdAt };
    (isOperatorScene(scene.sceneId) ? spacery : own).push(item);
  }
  own.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  spacery.sort((a, b) => a.title.localeCompare(b.title));
  return { own, spacery };
}
