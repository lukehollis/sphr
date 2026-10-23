import { allowAttempt } from "@/lib/server/admin-store";
import { AccountError, cleanText, hostingActive, payableSpaceCount, PreviewUsedError, readUser, type User } from "@/lib/server/accounts-store";
import { accountRequest, accountResponse, accountsEnabled, attemptKey, clientAddress, notifyOwner, publicOrigin, requestUser } from "@/lib/server/accounts";
import { billingEnabled } from "@/lib/server/billing";
import { advanceImports, createImport, describeImport, firstWaiting, importDaily, importMaxLinks, listImports, openImport, startItemSpace, summarizeImport,
  waitForChecks } from "@/lib/server/imports";
import { parseMatterportLink, readMatterportList, type ListedLink } from "@/lib/matterport-link";
import { previewAddressLimit, previewRefusal, previewWindow, type PreviewRefusal } from "@/lib/server/previews";
import { importStartedEmail } from "@/lib/server/emails";
import { siteBrand } from "@/lib/server/brand";
import { notifyTeam } from "@/lib/server/team-notify";
import { recordEvent } from "@/lib/server/analytics";

const listHelp = "Paste the links to your Matterport spaces, one per line, or choose a CSV file that lists them.";

/** The links of a request: `links` as addresses or { url, title }, or `text` as pasted or read from a CSV file. Each space once. */
function readLinks(body: { links?: unknown; text?: unknown } | null | undefined): ListedLink[] {
  if (typeof body?.text === "string") return readMatterportList(body.text).links;
  if (!Array.isArray(body?.links)) return [];
  const seen = new Set<string>();
  return body.links.slice(0, 5000).flatMap(entry => {
    const link = parseMatterportLink(typeof entry === "string" ? entry : (entry as { url?: unknown })?.url);
    if (!link || seen.has(link.modelId)) return [];
    seen.add(link.modelId);
    const title = typeof entry === "object" ? cleanText((entry as { title?: unknown }).title, 200) : null;
    return [{ ...link, ...(title ? { title } : {}) }];
  });
}

/**
 * Before hosting starts, the list's first space is the account's free preview when it is on offer, as a single link
 * would be. Otherwise it waits for payment, so Checkout has a space to bill when the account has none. True for a preview.
 */
async function firstSpace(user: User, listId: string, request: Request) {
  const first = firstWaiting(listId);
  if (!first) return false;
  let declined: PreviewRefusal | undefined = previewRefusal(user.id);
  if (!declined && !allowAttempt([[attemptKey("preview-address", clientAddress(request)), previewAddressLimit()]], previewWindow)) declined = "busy";
  if (!declined) {
    try {
      startItemSpace(user, first, "draft", { preview: true });
      await recordEvent("preview_started", { userId: user.id, props: { from: "import" } });
      return true;
    } catch (failure) {
      if (!(failure instanceof PreviewUsedError)) throw failure;
      declined = "used";
    }
  }
  if (declined !== "used") await recordEvent("preview_declined", { userId: user.id, props: { reason: declined, from: "import" } });
  if (!payableSpaceCount(user.id)) {
    try { startItemSpace(user, first, "unpaid"); }
    catch (failure) { if (!(failure instanceof AccountError)) throw failure; }
  }
  return false;
}

/** The customer's lists of Matterport spaces, newest first. */
export async function GET(request: Request) {
  if (!accountsEnabled()) return accountResponse({ error: "Accounts are unavailable." }, 404);
  const user = await requestUser(request, true);
  if (!user) return accountResponse({ error: "Sign in to continue." }, 401);
  return accountResponse({ imports: listImports(user.id).map(summarizeImport) });
}

/**
 * Brings over many Matterport spaces from a list of links, once the customer confirms they own them or have their
 * owners' permission. The links are checked with Matterport and come over one at a time (lib/server/imports.ts).
 * Before hosting starts, the first is the account's free preview when it is on offer, as a single link would be, or
 * waits for payment so Checkout has a space to bill; the others wait for hosting.
 */
export async function POST(request: Request) {
  const { user, body, agent, error } = await accountRequest(request, 512 * 1024, { agents: true });
  if (error) return error;
  if (!user.emailVerified) return accountResponse({ error: "Confirm your email address before adding a space." }, 403);
  const links = readLinks(body);
  if (!links.length) return accountResponse({ error: listHelp }, 400);
  if (links.length > importMaxLinks()) {
    return accountResponse({ error: `A list brings over up to ${importMaxLinks()} spaces. Split it, and add the next part once this one is on its way.` }, 400);
  }
  if (body?.permission !== true) return accountResponse({ error: "Confirm that you own these Matterport spaces or have their owners' permission." }, 400);
  if (!allowAttempt([[attemptKey("import", user.id), 10]], 60 * 60 * 1000)) return accountResponse({ error: "Too many lists. Try again later." }, 429);
  let list;
  try { list = createImport(user.id, links, new Date().toISOString()); }
  catch (failure) {
    if (failure instanceof AccountError) return accountResponse({ error: failure.message }, 400);
    throw failure;
  }
  // The first links' names come back in a moment; a long list goes on being checked in the background.
  let preview = false;
  const payment = billingEnabled() && !hostingActive(user.id);
  try {
    await waitForChecks(8000);
    if (payment) preview = await firstSpace(user, list.id, request);
  } finally { openImport(list.id); }
  await advanceImports(user.id);
  const view = describeImport(list);
  const coming = view.counts.total - view.counts.refused;
  await recordEvent("import_started", { userId: user.id, props: { links: view.counts.total, refused: view.counts.refused, from: agent ? "agent" : "web",
    ...(preview ? { preview: true } : {}), ...(payment ? { payment: true } : {}) } });
  void notifyTeam({ title: "Matterport list to bring over", fields: [["Account", user.email], ["Links", view.counts.total], ["Left out", view.counts.refused],
    ["Status", !payment ? "Hosting" : preview ? "Free preview first, the rest wait for hosting" : "Waiting for first payment"], ["From", agent ? "Their agent" : "The website"]] });
  if (coming) {
    void notifyOwner(readUser(user.id), importStartedEmail(siteBrand(), publicOrigin(request), { id: list.id, count: coming, refused: view.counts.refused,
      daily: importDaily(), payment, preview }));
  }
  return accountResponse({ ok: true, import: view, preview });
}
