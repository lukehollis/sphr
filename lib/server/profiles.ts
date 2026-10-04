import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { db, isScenePublic } from "./admin-store";
import { cleanText, listCustomerSpaces, readUser, readUserByEmail } from "./accounts-store";
import { spaceHosted } from "./accounts";
import { canBuildOn, isOperatorScene, listUserTours, onePerCapture, pickerSpace, tourPath } from "./user-tours";
import { readSceneTour } from "./tours";
import { readAllScenes } from "@/lib/scene-catalog";
import { webAddress } from "@/lib/space-info";
import { tourThumbnail } from "./tour-thumbnails";
import type { SceneListing } from "@/lib/scene-types";

/**
 * People's public profiles: a handle, a name, a picture and a cover, a few words about
 * them, and the tours and captures they share. People follow each other and heart tours.
 * A profile exists for every account but shows only what its owner has shared; nothing
 * from the account itself (email, billing) appears on it.
 */
export type Profile = { userId: string; handle: string; name: string | null; bio: string | null; location: string | null; website: string | null;
  avatar: string | null; cover: string | null; created: string; updated: string };
type ProfileRow = { user_id: string; handle: string; name: string | null; bio: string | null; location: string | null; website: string | null;
  avatar: string | null; cover: string | null; created: string; updated: string };

export const profileLimits = { name: 80, bio: 500, location: 120, website: 300 } as const;
const reserved = new Set(("admin administrator account accounts api app about help support settings profile profiles new edit delete login logout "
  + "signup sign-in sign-up spacery sphr tours tour spaces space library privacy terms u s t me you null undefined root staff team official").split(" "));
let prepared = false;

function store() {
  const connection = db();
  if (prepared) return connection;
  connection.exec(`
    CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT, bio TEXT,
      location TEXT, website TEXT, avatar TEXT, cover TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS follows (follower TEXT NOT NULL, followee TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(follower, followee));
    CREATE INDEX IF NOT EXISTS follows_followee ON follows(followee);
    CREATE TABLE IF NOT EXISTS tour_hearts (user_id TEXT NOT NULL, tour_id TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(user_id, tour_id));
    CREATE INDEX IF NOT EXISTS tour_hearts_tour ON tour_hearts(tour_id);
  `);
  prepared = true;
  return connection;
}

const toProfile = (row: ProfileRow): Profile => ({ userId: row.user_id, handle: row.handle, name: row.name, bio: row.bio, location: row.location,
  website: row.website, avatar: row.avatar, cover: row.cover, created: row.created, updated: row.updated });

export class ProfileError extends Error {}

/** A handle is 3 to 30 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit. */
export function validHandle(value: string) {
  return /^[a-z0-9][a-z0-9._-]{2,29}$/.test(value) && !reserved.has(value) && !/[._-]{2}/.test(value);
}

/**
 * The account's profile, made on first use with a neutral handle so nothing personal
 * (a name or an email) is published until its owner chooses to.
 */
export function ensureProfile(userId: string): Profile {
  const connection = store();
  const row = connection.prepare("SELECT * FROM profiles WHERE user_id=?").get(userId) as ProfileRow | undefined;
  if (row) return toProfile(row);
  const digest = createHash("sha256").update(userId).digest("hex");
  let handle = `member-${digest.slice(0, 6)}`;
  for (let length = 7; connection.prepare("SELECT 1 FROM profiles WHERE handle=?").get(handle); length++) handle = `member-${digest.slice(0, length)}`;
  const stamp = new Date().toISOString();
  connection.prepare("INSERT OR IGNORE INTO profiles(user_id, handle, created, updated) VALUES (?, ?, ?, ?)").run(userId, handle, stamp, stamp);
  return toProfile(connection.prepare("SELECT * FROM profiles WHERE user_id=?").get(userId) as ProfileRow);
}

export function readProfileByHandle(handle: string) {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(handle)) return undefined;
  const row = store().prepare("SELECT * FROM profiles WHERE handle=?").get(handle) as ProfileRow | undefined;
  return row && readUser(row.user_id) ? toProfile(row) : undefined;
}

/** Changes the words on a profile. Pictures change through `saveProfileImage`. */
export function updateProfile(userId: string, input: Record<string, unknown>) {
  const current = ensureProfile(userId);
  const next = { ...current };
  if (input.handle !== undefined) {
    const handle = typeof input.handle === "string" ? input.handle.trim().replace(/^@/, "").toLowerCase() : "";
    if (!validHandle(handle)) throw new ProfileError("Choose a handle of 3 to 30 letters, numbers, dots, dashes or underscores.");
    const taken = store().prepare("SELECT user_id FROM profiles WHERE handle=? AND user_id<>?").get(handle, userId);
    if (taken) throw new ProfileError("That handle is taken. Try another.");
    next.handle = handle;
  }
  for (const key of ["name", "location"] as const) {
    if (input[key] === undefined) continue;
    if (input[key] !== null && typeof input[key] !== "string") throw new ProfileError("Profile details must be text.");
    if (typeof input[key] === "string" && input[key].length > profileLimits[key]) throw new ProfileError(`Keep the ${key} under ${profileLimits[key]} characters.`);
    next[key] = cleanText(input[key], profileLimits[key]);
  }
  if (input.bio !== undefined) {
    if (input.bio !== null && typeof input.bio !== "string") throw new ProfileError("Profile details must be text.");
    const bio = typeof input.bio === "string" ? input.bio.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/\n{3,}/g, "\n\n").trim() : "";
    if (bio.length > profileLimits.bio) throw new ProfileError(`Keep the bio under ${profileLimits.bio} characters.`);
    next.bio = bio || null;
  }
  if (input.website !== undefined) {
    const text = typeof input.website === "string" ? input.website.trim() : "";
    if (text.length > profileLimits.website) throw new ProfileError("That web address is too long.");
    const address = text ? webAddress(text) : null;
    if (text && !address) throw new ProfileError("Enter a web address, like example.com.");
    next.website = address ?? null;
  }
  next.updated = new Date().toISOString();
  store().prepare("UPDATE profiles SET handle=?, name=?, bio=?, location=?, website=?, updated=? WHERE user_id=?")
    .run(next.handle, next.name, next.bio, next.location, next.website, next.updated, userId);
  return next;
}

// ---- Pictures ----

export const maxProfileImageBytes = 15 * 1024 * 1024;
const imageSizes = { avatar: { width: 512, height: 512 }, cover: { width: 2400, height: 800 } } as const;
export type ProfileImageKind = keyof typeof imageSizes;
const profileFiles = (userId: string) => path.join(process.env.SPHR_STATE_DIR ?? "", "profile-files", userId);

/** Keeps a new profile picture or cover, cropped to shape and re-encoded so no original file (or its location data) is served. */
export async function saveProfileImage(userId: string, kind: ProfileImageKind, bytes: Buffer) {
  const profile = ensureProfile(userId);
  let image: Buffer;
  try {
    const source = sharp(bytes, { limitInputPixels: 80_000_000, failOn: "error" });
    const meta = await source.metadata();
    if (!meta.format || !["jpeg", "png", "webp", "gif", "heif", "avif"].includes(meta.format)) throw new Error("format");
    const { width, height } = imageSizes[kind];
    image = await source.rotate().resize(width, height, { fit: "cover", position: "attention" }).webp({ quality: kind === "avatar" ? 86 : 82 }).toBuffer();
  } catch { throw new ProfileError("Upload a JPEG, PNG, WebP, HEIC or GIF image."); }
  const folder = profileFiles(userId);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const name = `${kind}-${createHash("sha256").update(image).digest("hex").slice(0, 16)}.webp`;
  writeFileSync(path.join(folder, name), image, { mode: 0o600 });
  const url = `/api/profile-files/${userId}/${name}`;
  const previous = profile[kind];
  store().prepare(`UPDATE profiles SET ${kind}=?, updated=? WHERE user_id=?`).run(url, new Date().toISOString(), userId);
  if (previous && previous !== url) rmSync(path.join(folder, previous.split("/").pop()!), { force: true });
  return url;
}

export function removeProfileImage(userId: string, kind: ProfileImageKind) {
  const profile = ensureProfile(userId);
  store().prepare(`UPDATE profiles SET ${kind}=NULL, updated=? WHERE user_id=?`).run(new Date().toISOString(), userId);
  if (profile[kind]) rmSync(path.join(profileFiles(userId), profile[kind]!.split("/").pop()!), { force: true });
}

export function profileImageFile(userId: string, name: string) {
  if (!/^[a-f0-9]{24}$/.test(userId) || !/^(avatar|cover)-[a-f0-9]{16}\.webp$/.test(name) || !process.env.SPHR_STATE_DIR) return null;
  const file = path.join(profileFiles(userId), name);
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}

// ---- Following and hearts ----

export function setFollowing(follower: string, followee: string, on: boolean) {
  if (follower === followee) throw new ProfileError("You can't follow yourself.");
  if (on) store().prepare("INSERT OR IGNORE INTO follows(follower, followee, created) VALUES (?, ?, ?)").run(follower, followee, new Date().toISOString());
  else store().prepare("DELETE FROM follows WHERE follower=? AND followee=?").run(follower, followee);
}

export function isFollowing(follower: string | undefined, followee: string) {
  return Boolean(follower && store().prepare("SELECT 1 FROM follows WHERE follower=? AND followee=?").get(follower, followee));
}

export function followCounts(userId: string) {
  const followers = (store().prepare("SELECT count(*) AS n FROM follows WHERE followee=?").get(userId) as { n: number }).n;
  const following = (store().prepare("SELECT count(*) AS n FROM follows WHERE follower=?").get(userId) as { n: number }).n;
  return { followers, following };
}

export function setHeart(userId: string, tourId: string, on: boolean) {
  if (on) store().prepare("INSERT OR IGNORE INTO tour_hearts(user_id, tour_id, created) VALUES (?, ?, ?)").run(userId, tourId, new Date().toISOString());
  else store().prepare("DELETE FROM tour_hearts WHERE user_id=? AND tour_id=?").run(userId, tourId);
  return heartCount(tourId);
}

export function heartCount(tourId: string) {
  return (store().prepare("SELECT count(*) AS n FROM tour_hearts WHERE tour_id=?").get(tourId) as { n: number }).n;
}

export function hasHeart(userId: string | undefined, tourId: string) {
  return Boolean(userId && store().prepare("SELECT 1 FROM tour_hearts WHERE user_id=? AND tour_id=?").get(userId, tourId));
}

// ---- What a profile shows ----

export type ProfileCard = { handle: string; name: string; avatar: string | null; path: string };

/** How a person appears beside their tours: their chosen name, or their handle. */
export function profileCard(userId: string): ProfileCard {
  const profile = ensureProfile(userId);
  return { handle: profile.handle, name: profile.name || profile.handle, avatar: profile.avatar, path: `/u/${profile.handle}` };
}

/** `hearts` is null for the site's own guided tours, which are spaces rather than tours people heart. */
export type SharedTour = { id: string; title: string; kind: "tour" | "hunt"; path: string; thumbnail: string | null; space: string | null;
  stops: number; hearts: number | null; updated: string };
export type SharedCapture = { sceneId: string; title: string; path: string; thumbnail: string; created: string };

/**
 * The account of the person who runs the site (`SPHR_OPERATOR_ACCOUNT`, its email address).
 * Its profile also shows the site's own public spaces and their guided tours as its work.
 */
export function operatorAccount() {
  const email = process.env.SPHR_OPERATOR_ACCOUNT?.trim();
  const user = email ? readUserByEmail(email) : undefined;
  return user?.emailVerified ? user.id : undefined;
}

/** Work titled as a test ("[test] …", "(E57 test)") stays off profiles, though its link still opens. */
const testTitle = (title: string) => /\[test\]|\btest\)/i.test(title);

/** The site's own public spaces that open in the viewer (Matterport embeds without a capture do not). */
async function operatorScenes() {
  return (await readAllScenes()).filter(scene => isOperatorScene(scene.sceneId) && isScenePublic(scene.sceneId) && !testTitle(scene.title)
    && !((scene.sourceType === "matterport" || scene.sourceType === "spaces") && scene.nodeCount === 0));
}

/** A space of the site's own that visitors open as a guided tour or hunt: one from the old collection, or one built in the admin. */
function operatorTour(scene: SceneListing): SharedTour | null {
  const authored = readSceneTour(scene.sceneId).experience;
  const stops = authored?.stops.length ?? 0;
  if (!stops && !(scene.hasGuidedTour ?? scene.legacy?.kind === "tour")) return null;
  return { id: `scene-${scene.sceneId}`, title: scene.title, kind: authored?.kind ?? "tour", path: scene.scenePath, thumbnail: tourThumbnail(`scene-${scene.sceneId}`) ?? scene.thumbnail ?? null,
    space: null, stops, hearts: null, updated: scene.createdAt };
}

/** The tours a person has shared that visitors can open, newest first. */
export async function sharedTours(userId: string): Promise<SharedTour[]> {
  const scenes = new Map((await readAllScenes()).map(scene => [scene.sceneId, scene]));
  const own = listUserTours(userId).flatMap(tour => {
    const scene = scenes.get(tour.sceneId);
    if (!tour.public || !scene || !canBuildOn(userId, scene) || testTitle(tour.title)) return [];
    return [{ id: tour.id, title: tour.title, kind: tour.kind, path: tourPath(tour), thumbnail: tourThumbnail(tour.id) ?? scene.thumbnail ?? null, space: scene.title,
      stops: tour.experience?.stops.length ?? 0, hearts: heartCount(tour.id), updated: tour.updated }];
  });
  if (userId !== operatorAccount()) return own;
  const site = (await operatorScenes()).flatMap(scene => operatorTour(scene) ?? []);
  return [...own, ...site.sort((a, b) => b.updated.localeCompare(a.updated))];
}

/** The person's own hosted spaces that are public, and for the site's operator the site's own. */
export async function sharedCaptures(userId: string): Promise<SharedCapture[]> {
  const scenes = new Map((await readAllScenes()).map(scene => [scene.sceneId, scene]));
  const own = listCustomerSpaces(userId).flatMap(space => {
    const scene = space.sceneId ? scenes.get(space.sceneId) : undefined;
    if (!scene || space.status !== "ready" || !spaceHosted(space) || !isScenePublic(scene.sceneId) || testTitle(scene.title)) return [];
    return [{ sceneId: scene.sceneId, title: scene.title, path: scene.scenePath, thumbnail: scene.thumbnail, created: space.created }];
  });
  if (userId !== operatorAccount()) return own;
  // The same capture listed twice (an older copy and a newer conversion) shows once; guided tours show with the tours.
  const spaces = (await operatorScenes()).filter(scene => !operatorTour(scene));
  const kept = new Set(onePerCapture(spaces.map(pickerSpace)).map(space => space.sceneId));
  const site = spaces.filter(scene => kept.has(scene.sceneId))
    .map(scene => ({ sceneId: scene.sceneId, title: scene.title, path: scene.scenePath, thumbnail: scene.thumbnail, created: scene.createdAt }));
  return [...own, ...site.sort((a, b) => b.created.localeCompare(a.created))];
}

/** Recently shared tours from the people someone follows. */
export async function followingTours(userId: string, limit = 9) {
  const people = (store().prepare("SELECT followee FROM follows WHERE follower=? ORDER BY created DESC LIMIT 200").all(userId) as { followee: string }[])
    .map(row => row.followee);
  const tours = (await Promise.all(people.map(async person => (await sharedTours(person)).map(tour => ({ ...tour, by: profileCard(person) })))))
    .flat().sort((a, b) => b.updated.localeCompare(a.updated));
  return tours.slice(0, limit);
}
