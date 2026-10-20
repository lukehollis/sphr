import { isBrowserNoise } from "../browser-noise";
import { saveEvent } from "./analytics-store";
import { notifyTeam, type TeamEvent } from "./team-notify";

// Errors people run into, on the server or in their browser. Each one is recorded with the
// analytics (so /admin/analytics shows where it happened) and the operator hears about each
// kind of error once an hour, however often it repeats.

const told = new Map<string, number>();
const quietFor = 60 * 60 * 1000;

function noticeOnce(key: string, event: TeamEvent) {
  const now = Date.now();
  if (told.size > 500) for (const [name, at] of told) if (now - at > quietFor) told.delete(name);
  if (now - (told.get(key) ?? 0) < quietFor) return;
  told.set(key, now);
  void notifyTeam(event);
}

const pathOnly = (path: string) => path.split("?")[0].slice(0, 200);

/** Called by instrumentation.ts for errors Next.js catches while rendering a page or running a route. */
export function reportServerError(error: unknown, request: { path: string; method: string }, context: { routePath: string; routeType: string }) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300) || "Unknown error";
  const digest = typeof error === "object" && error && "digest" in error ? String((error as { digest: unknown }).digest).slice(0, 40) : "";
  const path = pathOnly(request.path);
  saveEvent("server_error", { path, props: { message: message.slice(0, 200), route: context.routePath, kind: context.routeType, method: request.method, digest } });
  noticeOnce(`server ${context.routePath} ${message}`, { title: "Server error", tone: "bad", description: message,
    fields: [["Page", path], ["Route", context.routePath], ["Method", request.method]] });
}

/** A step that failed on the server without throwing, such as Stripe refusing to start Checkout. */
export function reportProblem(title: string, message: string, fields: TeamEvent["fields"] = []) {
  noticeOnce(`problem ${title} ${message}`, { title, tone: "bad", description: message.slice(0, 500), fields });
}

// Graphics drawn without a graphics card. Chrome uses SwiftShader only when started with a flag, as automated
// browsers are; a page they open loses its context before the first picture and often never gets it back.
const softwareGpu = /SwiftShader|llvmpipe|softpipe|Basic Render Driver/i;

/** A JavaScript error in someone's browser, sent with the page's analytics. */
export function reportClientError(props: Record<string, string | number | boolean>, path: string | null, device: string) {
  const message = String(props.message ?? "").slice(0, 300);
  const source = String(props.source ?? "");
  // A page that reloaded itself after part of it didn't arrive usually recovers. It stays in the analytics,
  // and the operator hears about it only if it is still failing after the reload. Scripts that apps and
  // extensions inject into the page stay in the analytics too, but they aren't this site's errors, and
  // neither is a software renderer losing its context.
  if (!message || source === "reloaded the page" || isBrowserNoise(message) || isBrowserNoise(source)) return;
  if (props.kind === "webgl" && softwareGpu.test(source)) return;
  noticeOnce(`client ${message}`, { title: "Error in a visitor's browser", tone: "warn", description: message,
    fields: [["Page", path], ["Where", props.source ? String(props.source) : null], ["Browser", device], ["Kind", props.kind ? String(props.kind) : null],
      // What the network answered for a part it keeps refusing (lib/missing-part.ts).
      ["Network said", props.detail ? String(props.detail) : null]] });
}
