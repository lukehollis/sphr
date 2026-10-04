import { db, EditConflict } from "./admin-store";
import { parseSpaceInfo, type SpaceInfo } from "../space-info";

// Details about each space (description, location, who captured it, contact), kept by
// scene ID next to the title and start view edits, for the operator's and customers' spaces alike.
let prepared = false;

function store() {
  const connection = db();
  if (prepared) return connection;
  connection.exec("CREATE TABLE IF NOT EXISTS space_info (scene TEXT PRIMARY KEY, info TEXT NOT NULL, revision INTEGER NOT NULL, changed TEXT NOT NULL)");
  prepared = true;
  return connection;
}

export function readSpaceInfo(scene: string): { info: SpaceInfo; revision: number } {
  if (!process.env.SPHR_STATE_DIR || !/^[a-f0-9]{12}$/.test(scene)) return { info: {}, revision: 0 };
  const row = store().prepare("SELECT info, revision FROM space_info WHERE scene=?").get(scene) as { info: string; revision: number } | undefined;
  if (!row) return { info: {}, revision: 0 };
  try { return { info: parseSpaceInfo(JSON.parse(row.info)), revision: row.revision }; }
  catch (error) {
    console.error(`Ignoring unreadable details for ${scene}:`, error instanceof Error ? error.message : error);
    return { info: {}, revision: row.revision };
  }
}

/** Replaces a space's details, refusing a stale revision. */
export function saveSpaceInfo(scene: string, revision: number, info: SpaceInfo) {
  if (!/^[a-f0-9]{12}$/.test(scene) || !Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid edit.");
  const connection = store();
  connection.exec("BEGIN IMMEDIATE");
  try {
    const row = connection.prepare("SELECT revision FROM space_info WHERE scene=?").get(scene) as { revision: number } | undefined;
    if ((row?.revision ?? 0) !== revision) throw new EditConflict("These details were edited elsewhere. Reload before saving.");
    connection.prepare(`INSERT INTO space_info(scene, info, revision, changed) VALUES (?, ?, ?, ?)
      ON CONFLICT(scene) DO UPDATE SET info=excluded.info, revision=excluded.revision, changed=excluded.changed`)
      .run(scene, JSON.stringify(info), revision + 1, new Date().toISOString());
    connection.exec("COMMIT");
    return { info, revision: revision + 1 };
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
}
