import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseLibrary, type LibraryModel } from "@/lib/experience/library";

let cached: { at: number; models: LibraryModel[] } | null = null;

/**
 * Models offered in the tour builder, from SPHR_LIBRARY_URL (a manifest URL)
 * or SPHR_LIBRARY_FILE (a local manifest). Without either there is no library.
 */
export async function readLibrary(): Promise<LibraryModel[]> {
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.models;
  let models: LibraryModel[] = [];
  try {
    const url = process.env.SPHR_LIBRARY_URL?.trim();
    const file = process.env.SPHR_LIBRARY_FILE?.trim();
    if (url) {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (response.ok) models = parseLibrary(await response.json(), url.replace(/\/[^/]*$/, ""));
    } else if (file) {
      models = parseLibrary(JSON.parse(await readFile(path.resolve(file), "utf8")), process.env.SPHR_LIBRARY_BASE_URL ?? "");
    }
  } catch (error) {
    console.error("Unable to read the model library:", error instanceof Error ? error.message : error);
  }
  cached = { at: Date.now(), models };
  return models;
}

/** Library models this editor may place; team models only for administrators. */
export async function libraryModels(team = false) {
  return (await readLibrary()).filter((model) => team || model.scope !== "team");
}
