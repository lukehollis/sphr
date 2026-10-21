import { db, EditConflict } from "./admin-store";
import { readableTags, type SpaceTag } from "../space-tags";

// An owner's tags for each space, kept by scene ID beside its details. A saved list replaces the
// tags the capture came with; saving null (restoring) shows those again.
let prepared = false;

function store() {
  const connection = db();
  if (prepared) return connection;
  connection.exec("CREATE TABLE IF NOT EXISTS space_tags (scene TEXT PRIMARY KEY, tags TEXT NOT NULL, revision INTEGER NOT NULL, changed TEXT NOT NULL)");
  prepared = true;
  return connection;
}

/** The owner's tags for a space, or null while it shows the tags its capture came with. */
export function readSpaceTags(scene: string): { tags: SpaceTag[] | null; revision: number } {
  if (!process.env.SPHR_STATE_DIR || !/^[a-f0-9]{12}$/.test(scene)) return { tags: null, revision: 0 };
  const row = store().prepare("SELECT tags, revision FROM space_tags WHERE scene=?").get(scene) as { tags: string; revision: number } | undefined;
  if (!row) return { tags: null, revision: 0 };
  try {
    const saved = JSON.parse(row.tags) as unknown;
    return { tags: saved === null ? null : readableTags(saved), revision: row.revision };
  } catch (error) {
    console.error(`Ignoring unreadable tags for ${scene}:`, error instanceof Error ? error.message : error);
    return { tags: null, revision: row.revision };
  }
}

/** Replaces a space's tags (null restores the capture's own), refusing a stale revision. */
export function saveSpaceTags(scene: string, revision: number, tags: SpaceTag[] | null) {
  if (!/^[a-f0-9]{12}$/.test(scene) || !Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid edit.");
  const connection = store();
  connection.exec("BEGIN IMMEDIATE");
  try {
    const row = connection.prepare("SELECT revision FROM space_tags WHERE scene=?").get(scene) as { revision: number } | undefined;
    if ((row?.revision ?? 0) !== revision) throw new EditConflict("These tags were edited elsewhere. Reload before saving.");
    connection.prepare(`INSERT INTO space_tags(scene, tags, revision, changed) VALUES (?, ?, ?, ?)
      ON CONFLICT(scene) DO UPDATE SET tags=excluded.tags, revision=excluded.revision, changed=excluded.changed`)
      .run(scene, JSON.stringify(tags), revision + 1, new Date().toISOString());
    connection.exec("COMMIT");
    return { tags, revision: revision + 1 };
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
}
