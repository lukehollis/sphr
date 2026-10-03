import { parseExperience } from "@/lib/experience/validate";
import type { Experience } from "@/lib/experience/types";
import { readSceneTourRow } from "@/lib/server/admin-store";

export type SceneTour = { experience: Experience | null; revision: number };

/** The authored tour or scavenger hunt for one space, if any. Unknown effects are dropped. */
export function readSceneTour(scene: string): SceneTour {
  const row = readSceneTourRow(scene);
  if (!row.experience) return { experience: null, revision: row.revision };
  try { return { experience: parseExperience(row.experience, { lenient: true }), revision: row.revision }; }
  catch (error) {
    console.error(`Ignoring an unreadable tour for ${scene}:`, error instanceof Error ? error.message : error);
    return { experience: null, revision: row.revision };
  }
}
