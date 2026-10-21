import { parseMatterportLink } from "../matterport-link";
import type { SpaceSource } from "./accounts-store";

/** Matterport's model graph, which its showcase reads. The route tests point it at a local stand-in. */
const graphUrl = () => `${(process.env.SPHR_MATTERPORT_TEST_BASE || "https://my.matterport.com").replace(/\/+$/, "")}/api/mp/models/graph`;
// The showcase's own view of a space: its name from the root model, and the sweeps it shows.
const checkQuery = `query CheckModel($modelId: ID!) {
  root: model(id: $modelId, view: root) { id name }
  space: model(id: $modelId, view: default) { id locations(tags: ["showcase"]) { id } }
}`;

export const linkHelp = "Paste the link to a Matterport space, such as https://my.matterport.com/show/?m=…";
export const permissionHelp = "Confirm that you own this Matterport space or have its owner's permission.";
export const missingHelp = "This Matterport space did not open. Check the link, and that the space is public or unlisted on Matterport: "
  + "a private space or one with a password cannot be brought over.";

export type MatterportLookup = { found: true; name: string; sweeps: number } | { found: false; reason: "missing" | "combined" | "empty" };

/**
 * Asks Matterport about the space as its showcase does, to name it and to check that it opens without signing in.
 * A private, password-protected or missing space has no model. Throws when Matterport cannot be reached or answers
 * with anything but its usual reply, so the caller can go on without the check: the worker reports the same problems.
 */
export async function lookupMatterport(modelId: string): Promise<MatterportLookup> {
  const response = await fetch(graphUrl(), {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json", "x-matterport-application-name": "showcase" },
    body: JSON.stringify({ operationName: "CheckModel", variables: { modelId }, query: checkQuery })
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Matterport answered ${response.status}.`);
  }
  const answer = await response.json() as { data?: { root?: { id?: string; name?: string } | null; space?: { id?: string; locations?: unknown[] } | null } };
  const root = answer.data?.root, space = answer.data?.space;
  if (!space || space.id !== modelId) return { found: false, reason: "missing" };
  // A combined space shows several models as one; the importer reads one model at a time.
  if (!root || root.id !== space.id) return { found: false, reason: "combined" };
  const sweeps = Array.isArray(space.locations) ? space.locations.length : 0;
  if (!sweeps) return { found: false, reason: "empty" };
  return { found: true, name: typeof root.name === "string" ? root.name.trim().slice(0, 200) : "", sweeps };
}

export const lookupText: Record<Exclude<MatterportLookup, { found: true }>["reason"], string> = {
  missing: missingHelp,
  combined: "This Matterport link opens a combined space made of several spaces. Paste the link to one of them instead.",
  empty: "This Matterport space has no 360 photos to bring over."
};

/** The link and the customer's confirmation from a request body, or the reason they cannot be used. */
export function readMatterportRequest(body: { matterport?: unknown; permission?: unknown } | null | undefined): { source: SpaceSource } | { error: string } {
  const link = parseMatterportLink(body?.matterport);
  if (!link) return { error: linkHelp };
  if (body?.permission !== true) return { error: permissionHelp };
  return { source: { kind: "matterport", ...link, permission: new Date().toISOString() } };
}
