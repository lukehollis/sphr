/**
 * A Matterport space given by its link: the showcase address (my.matterport.com/show/?m=…), the owner's
 * Matterport Cloud page (/models/…) or a Discover page (/space/…). Pasted embed code works too, since only
 * the first matterport.com address in the text is read. The result is always the showcase address.
 */
export function parseMatterportLink(input: unknown): { modelId: string; url: string } | undefined {
  if (typeof input !== "string") return undefined;
  const found = input.slice(0, 4000).match(/(?<![a-z0-9.-])(?:https?:\/\/)?(?:[a-z0-9-]+\.)*matterport\.com\/[^\s"'<>]*/i)?.[0];
  if (!found) return undefined;
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(found) ? found : `https://${found}`); } catch { return undefined; }
  if (!/(^|\.)matterport\.com$/i.test(url.hostname)) return undefined;
  const modelId = url.searchParams.get("m") ?? url.pathname.match(/\/(?:models|space)\/([A-Za-z0-9]{11})(?:\/|$)/)?.[1];
  if (!modelId || !/^[A-Za-z0-9]{11}$/.test(modelId)) return undefined;
  return { modelId, url: `https://my.matterport.com/show/?m=${modelId}` };
}

