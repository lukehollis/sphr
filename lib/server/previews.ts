import { countPreviewsSince, hostingActive, markPreviewsHosted, previewRuns, readPreviewGrant, readSpacePreview, type CustomerSpace, type PreviewGrant } from "./accounts-store";
import { billingEnabled } from "./billing";

// The free preview: an account's first capture is processed and opened privately before any payment, and
// payment publishes it or keeps it hosted. Each run costs agent time, so the preview is capped: one per
// account, a few files, a few gigabytes, a few runs, and a daily budget for the whole site. A capture over the
// caps, or a preview that is not on offer, goes the old way: the space waits for payment before files upload.
// Every number can be changed in the environment without a rebuild.

const env = (name: string) => process.env[name]?.trim() || undefined;
function whole(name: string, fallback: number) {
  const value = Number(env(name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Days a preview stays open once its first result is ready. */
export const previewDays = () => whole("SPHR_PREVIEW_DAYS", 7);
/** Agent runs one preview space may use (the first and any retries). */
export const previewMaxRuns = () => whole("SPHR_PREVIEW_MAX_RUNS", 3);
/** New previews started in any 24 hours across the whole site. */
export const previewDailyLimit = () => whole("SPHR_PREVIEW_DAILY_LIMIT", 10);
/** New previews started from one network address in 24 hours. Schools and offices share addresses, so it is not tiny. */
export const previewAddressLimit = () => whole("SPHR_PREVIEW_ADDRESS_LIMIT", 5);
export const previewWindow = 24 * 60 * 60 * 1000;

/** What one preview holds, unless the operator approved more for the account (max_files and max_bytes on its grant). */
export function previewLimits(grant?: PreviewGrant) {
  const gigabytes = Number(env("SPHR_PREVIEW_MAX_GB"));
  return { files: grant?.maxFiles ?? whole("SPHR_PREVIEW_MAX_FILES", 100), bytes: grant?.maxBytes ?? (gigabytes > 0 ? gigabytes * 1e9 : 5e9) };
}

export type PreviewView = {
  /** When the first result was ready, which starts the window; null until then. */
  ready: string | null;
  /** When the preview closes, once its window has started. */
  until: string | null;
  /** Still usable: the window has not started or has not ended. */
  open: boolean;
  expired: boolean;
  daysLeft: number | null;
  files: number;
  bytes: number;
  runsLeft: number;
};

/**
 * The free preview a space is in. Null when the space is not one, or has been hosted since: it is then an ordinary
 * space for good, so a subscription that ends later takes it offline like any other rather than reopening a window.
 */
export function spacePreview(space: CustomerSpace): PreviewView | null {
  if (!billingEnabled() || space.status === "deleted") return null;
  const grant = readSpacePreview(space.id);
  if (!grant || grant.hosted) return null;
  // Hosting that did not come through a saved subscription (an invoiced team's plan) is noticed here.
  if (hostingActive(space.userId)) { markPreviewsHosted([grant.userId]); return null; }
  const until = grant.ready ? Date.parse(grant.ready) + previewDays() * 86400000 : null;
  const expired = until !== null && until <= Date.now();
  const limits = previewLimits(grant);
  return { ready: grant.ready, until: until === null ? null : new Date(until).toISOString(), open: !expired, expired,
    daysLeft: until === null || expired ? null : Math.max(1, Math.ceil((until - Date.now()) / 86400000)), files: limits.files, bytes: limits.bytes,
    runsLeft: Math.max(0, previewMaxRuns() - previewRuns(space.id)) };
}

/** Whether a space is a free preview its owner can still open, add files to and process. */
export function previewOpen(space: CustomerSpace) {
  return Boolean(spacePreview(space)?.open);
}

export type PreviewRefusal = "used" | "large" | "busy";

/**
 * Why the account's next space cannot be its free preview, or undefined when it can. `declared` is what the
 * customer is about to upload, when the page knows. The upload route checks the real numbers again, so a page
 * (or an agent) that leaves it out only finds out at the first file.
 */
export function previewRefusal(userId: string, declared?: { count: number; bytes: number }): PreviewRefusal | undefined {
  const grant = readPreviewGrant(userId);
  if (grant?.spaceId) return "used";
  const limits = previewLimits(grant);
  if (declared && (declared.count > limits.files || declared.bytes > limits.bytes)) return "large";
  if (countPreviewsSince(new Date(Date.now() - previewWindow).toISOString()) >= previewDailyLimit()) return "busy";
  return undefined;
}

/** What the upload sheet and the plan page need to describe the offer. Null when there is no billing, so no preview. */
export function previewOffer(userId: string) {
  if (!billingEnabled()) return null;
  const grant = readPreviewGrant(userId);
  const limits = previewLimits(grant);
  return { available: !grant?.spaceId && !hostingActive(userId), used: Boolean(grant?.spaceId), days: previewDays(), maxFiles: limits.files, maxBytes: limits.bytes };
}

export type PreviewGate = "publish" | "ended" | "limit";

const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : "";

/**
 * The 402 body for something a free preview does not cover: making it public, or any use after its window,
 * or more files and runs than it holds. `plan` is the page where hosting starts for this space.
 */
export function previewGateBody(space: CustomerSpace, gate: PreviewGate, detail = "") {
  const until = day(spacePreview(space)?.until ?? null);
  const error = gate === "publish" ? "A free preview stays private. Start hosting to make it public and to embed it. Its link and everything in it stay as they are."
    : gate === "ended" ? `Your free preview ended${until ? ` on ${until}` : ""}, so this space is offline. Start hosting to bring it back.`
    : `${detail} Start hosting to go past it.`;
  return { error, gate, plan: `/account/plan?space=${space.id}` };
}

/** Why the offer was not made, in words for the person who asked. */
export const refusalText: Record<PreviewRefusal, string> = {
  used: "Your free preview is already used, so this space starts with payment.",
  large: "This capture is larger than a free preview holds, so this space starts with payment.",
  busy: "Free previews are paused for today, so this space starts with payment. Try again tomorrow for a free preview."
};
