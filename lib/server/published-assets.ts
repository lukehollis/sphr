import { accessToken } from "./uploads";

// Published customer scenes live under <prefix>/scenes/<sceneId>/<revision>/ in the customer asset bucket.
// Removing them needs SPHR_CUSTOMER_ASSET_BUCKET and storage delete access for the application.
const env = (name: string) => process.env[name]?.trim() || undefined;
const bucket = () => env("SPHR_CUSTOMER_ASSET_BUCKET");
const prefix = () => (env("SPHR_CUSTOMER_ASSET_PREFIX") ?? "sphr").replace(/^\/+|\/+$/g, "");

async function listObjects(folder: string) {
  const names: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket()!)}/o`);
    url.search = new URLSearchParams({ prefix: folder, fields: "items(name),nextPageToken", ...(pageToken ? { pageToken } : {}) }).toString();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Listing published files failed: HTTP ${response.status}`);
    const page = await response.json() as { items?: { name: string }[]; nextPageToken?: string };
    names.push(...(page.items ?? []).map(item => item.name));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return names;
}

async function deleteObjects(names: string[]) {
  for (let index = 0; index < names.length; index += 8) {
    await Promise.all(names.slice(index, index + 8).map(async name => {
      const response = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket()!)}/o/${encodeURIComponent(name)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(20000) });
      if (!response.ok && response.status !== 404) throw new Error(`Deleting ${name} failed: HTTP ${response.status}`);
    }));
  }
}

/** Removes every published revision of a scene, or all but `keepRevision`. */
export async function removePublishedScene(sceneId: string, keepRevision?: string) {
  if (!bucket() || !/^[a-f0-9]{12}$/.test(sceneId)) return 0;
  const folder = `${prefix()}/scenes/${sceneId}/`;
  const names = (await listObjects(folder)).filter(name => !keepRevision || !name.startsWith(`${folder}${keepRevision}/`));
  await deleteObjects(names);
  return names.length;
}

/** The revision folder of a published listing's bootstrap URL, e.g. "e2bac6a45e4535b8". */
export function listingRevision(listing: unknown) {
  const url = (listing as { bootstrapUrl?: unknown })?.bootstrapUrl;
  return typeof url === "string" ? url.match(/\/scenes\/[a-f0-9]{12}\/([a-f0-9]{16})\/bootstrap\.json$/)?.[1] : undefined;
}
