import { randomBytes } from "node:crypto";
import { db } from "./admin-store";
import { hostingActive } from "./accounts-store";
import { billingEnabled } from "./billing";

/**
 * Class results. When a customer's tour or scavenger hunt is shared, players type their name before
 * they start (or play without one), and the tour's owner sees how far each one got: the finds and
 * the finish of a hunt, the stop a tour reached, and the time spent. Owners can stop asking for
 * names on a tour and delete its results; plays are kept for a year. Without a plan an owner sees
 * every count and the first FREE_PLAYERS players; any plan shows them all, with a CSV download.
 */
export type TourPlay = { id: string; tourId: string; name: string; started: string; updated: string; found: number; steps: number;
  stop: number; stops: number; finished: string | null; seconds: number };
type PlayRow = { id: string; tour_id: string; name: string; started: string; updated: string; found: number; steps: number;
  stop: number; stops: number; finished: string | null; seconds: number };

export const FREE_PLAYERS = 5;
export const MAX_NAME = 40;
const keepMs = 366 * 24 * 60 * 60 * 1000;
let prepared = false;

function store() {
  const connection = db();
  if (prepared) return connection;
  connection.exec(`
    CREATE TABLE IF NOT EXISTS tour_plays (id TEXT PRIMARY KEY, tour_id TEXT NOT NULL, name TEXT NOT NULL, started TEXT NOT NULL,
      updated TEXT NOT NULL, found INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0, stop INTEGER NOT NULL DEFAULT 0,
      stops INTEGER NOT NULL DEFAULT 0, finished TEXT, seconds INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS tour_plays_tour ON tour_plays(tour_id, started);
    CREATE TABLE IF NOT EXISTS tour_results_off (tour_id TEXT PRIMARY KEY);
  `);
  prepared = true;
  return connection;
}

const toPlay = (row: PlayRow): TourPlay => ({ id: row.id, tourId: row.tour_id, name: row.name, started: row.started, updated: row.updated,
  found: row.found, steps: row.steps, stop: row.stop, stops: row.stops, finished: row.finished, seconds: row.seconds });

/** What a player typed, tidied to one line of at most MAX_NAME characters; empty for none. */
export function playerName(value: unknown) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
}

/** Whether a shared tour asks its players for their names (its owner can turn that off). */
export function askingNames(tourId: string) {
  return !store().prepare("SELECT 1 FROM tour_results_off WHERE tour_id=?").get(tourId);
}

export function setAskingNames(tourId: string, asking: boolean) {
  if (asking) store().prepare("DELETE FROM tour_results_off WHERE tour_id=?").run(tourId);
  else store().prepare("INSERT OR IGNORE INTO tour_results_off VALUES (?)").run(tourId);
}

/** Starts a play. `first` is true for a tour's first play of the day, so the operator hears when a class starts. */
export function startPlay(tourId: string, name: string) {
  const connection = store();
  const stamp = new Date().toISOString();
  const first = !connection.prepare("SELECT 1 FROM tour_plays WHERE tour_id=? AND started>=? LIMIT 1").get(tourId, stamp.slice(0, 10));
  let id: string;
  do id = randomBytes(6).toString("hex"); while (connection.prepare("SELECT 1 FROM tour_plays WHERE id=?").get(id));
  connection.prepare("INSERT INTO tour_plays (id, tour_id, name, started, updated) VALUES (?, ?, ?, ?, ?)").run(id, tourId, name, stamp, stamp);
  connection.prepare("DELETE FROM tour_plays WHERE updated<?").run(new Date(Date.now() - keepMs).toISOString());
  return { id, first };
}

const whole = (value: unknown, top: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(Math.round(value), top)) : 0;

/** A play's progress. Numbers only grow and the finish is kept once reached. False when there is no such play. */
export function updatePlay(tourId: string, playId: unknown, progress: Record<string, unknown>) {
  if (typeof playId !== "string" || !/^[a-f0-9]{12}$/.test(playId)) return false;
  const stamp = new Date().toISOString();
  const result = store().prepare(`UPDATE tour_plays SET updated=?, found=MAX(found, ?), steps=MAX(steps, ?), stop=MAX(stop, ?), stops=MAX(stops, ?),
      seconds=MAX(seconds, ?), finished=COALESCE(finished, ?) WHERE id=? AND tour_id=?`)
    .run(stamp, whole(progress.found, 999), whole(progress.steps, 999), whole(progress.stop, 9999), whole(progress.stops, 9999),
      whole(progress.seconds, 6 * 3600), progress.finished === true ? stamp : null, playId, tourId);
  return Number(result.changes) > 0;
}

/** A tour's plays, the first players first. */
export function listPlays(tourId: string) {
  return (store().prepare("SELECT * FROM tour_plays WHERE tour_id=? ORDER BY started, id").all(tourId) as PlayRow[]).map(toPlay);
}

export function deletePlays(tourId: string) {
  store().prepare("DELETE FROM tour_plays WHERE tour_id=?").run(tourId);
  store().prepare("DELETE FROM tour_plays WHERE updated<?").run(new Date(Date.now() - keepMs).toISOString());
}

/** Whether an owner sees every player: any plan (a subscription that bills), or a deployment without billing. */
export function allPlayersShown(userId: string) {
  return !billingEnabled() || hostingActive(userId);
}

/** How far a play got, in words, for the results table and the CSV. */
export function playProgress(play: TourPlay, kind: "tour" | "hunt") {
  if (kind === "hunt") return play.steps ? `${play.found} of ${play.steps} found` : "Not started";
  return play.stops ? `Stop ${play.stop} of ${play.stops}` : "Not started";
}

export function playMinutes(seconds: number) {
  if (seconds < 60) return seconds ? "Under a minute" : "-";
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
