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

/** A Matterport space found in a list, with the title its row gives it. */
export type ListedLink = { modelId: string; url: string; title?: string };

/** The cells of one line of a CSV file, split on its delimiter outside quotes. */
function cells(line: string, delimiter: string) {
  const found: string[] = [];
  let cell = "", quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') { cell += '"'; index++; }
    else if (character === '"' && (quoted || !cell.trim())) quoted = !quoted;
    else if (character === delimiter && !quoted) { found.push(cell.trim()); cell = ""; }
    else cell += character;
  }
  return [...found, cell.trim()];
}

/**
 * Every Matterport space in a pasted list or a CSV file: links anywhere on each line, in any column, as addresses,
 * Matterport Cloud or Discover pages, or embed code. When a header row names a title or name column, a row with one
 * link gives its space that title. A space listed twice is kept once. Lines with text but no Matterport link are
 * counted, so the page can say how many it left out.
 */
export function readMatterportList(text: string) {
  const lines = text.slice(0, 2_000_000).split(/\r\n|\r|\n/).filter(line => line.trim());
  const first = lines[0] ?? "";
  // The delimiter is whichever of comma, tab and semicolon the first line uses most; a plain list has none.
  const delimiter = [",", "\t", ";"].map(mark => [mark, first.split(mark).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const links: ListedLink[] = [];
  const seen = new Set<string>();
  let titleColumn = -1, repeated = 0, unreadable = 0;
  lines.forEach((line, index) => {
    const found = (line.match(/(?<![a-z0-9.-])(?:https?:\/\/)?(?:[a-z0-9-]+\.)*matterport\.com\/[^\s"'<>,;]*/gi) ?? [])
      .map(parseMatterportLink).filter((link): link is NonNullable<typeof link> => Boolean(link));
    if (!found.length) {
      const header = cells(line, delimiter);
      if (index === 0 && header.some(cell => /^(?:title|name|space|space name|space title|model name|link|url|address|matterport)$/i.test(cell))) {
        titleColumn = header.findIndex(cell => /^(?:title|name|space|space name|space title|model name)$/i.test(cell));
      } else unreadable++;
      return;
    }
    const title = titleColumn >= 0 && found.length === 1 ? cells(line, delimiter)[titleColumn]?.replace(/\s+/g, " ").trim().slice(0, 200) : undefined;
    for (const link of found) {
      if (seen.has(link.modelId)) { repeated++; continue; }
      seen.add(link.modelId);
      links.push({ ...link, ...(title && !/matterport\.com\//i.test(title) ? { title } : {}) });
    }
  });
  return { links, repeated, unreadable };
}

