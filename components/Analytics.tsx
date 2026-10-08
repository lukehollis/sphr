"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { isBrowserNoise } from "@/lib/browser-noise";

// Sends page views and the steps people take to the site's own analytics (see
// lib/server/analytics.ts), and the same events to Google Analytics when it is loaded.

type Props = Record<string, string | number | boolean>;
declare global { interface Window { gtag?: (...args: unknown[]) => void } }

const enabled = process.env.NEXT_PUBLIC_SPHR_ANALYTICS === "1";
// A neutral name: blocklists that drop requests to ".../analytics" would hide whole visits.
const endpoint = "/api/steps";
const operatorPage = (path: string) => path === "/admin" || path.startsWith("/admin/");
// Google's name for the same step, so its reports pick it up.
const googleNames: Record<string, string> = { checkout_opened: "begin_checkout" };

/** The page's address without its query, except campaign tags (links can carry tokens). */
function pageUrl() {
  const kept = [...new URLSearchParams(window.location.search)].filter(([key]) => key.startsWith("utm_") || key === "ref");
  return `${window.location.origin}${window.location.pathname}${kept.length ? `?${new URLSearchParams(kept)}` : ""}`;
}

function send(name: string, props?: Props) {
  if (!enabled || operatorPage(window.location.pathname)) return;
  const body = JSON.stringify({ events: [{ name, path: `${window.location.host}${window.location.pathname}`, props }],
    referrer: document.referrer || null, url: pageUrl() });
  try { if (navigator.sendBeacon?.(endpoint, body)) return; } catch { /* falls back to fetch */ }
  void fetch(endpoint, { method: "POST", body, keepalive: true }).catch(() => undefined);
}

/** Records a step, such as opening the upload sheet or the payment page. */
export function track(name: string, props?: Props) {
  send(name, props);
  googleEvent(googleNames[name] ?? name, props);
}

/** Google Analytics only, for steps the server already records (sign-up, payment). */
export function googleEvent(name: string, params?: Record<string, unknown>) {
  try { window.gtag?.("event", name, params ?? {}); } catch { /* analytics never breaks the page */ }
}

let reported = 0;

/** Where in our code an error was thrown (file:line:column of its first frame in a script of ours), from its stack. */
function thrownAt(error: unknown) {
  const stack = error instanceof Error ? error.stack ?? "" : "";
  return /(\/_next\/[^\s()]+:\d+:\d+)/.exec(stack)?.[1] ?? "";
}

/** Sends a JavaScript error (a few per page at most) so failures on some browser or device show up. */
export function reportError(kind: string, error: unknown, source = "") {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "")).slice(0, 200);
  if (!message || isBrowserNoise(message) || isBrowserNoise(source) || reported >= 5) return;
  reported++;
  send("client_error", { kind, message, source: source.replace(window.location.origin, "").slice(0, 120) });
}

export default function Analytics() {
  const pathname = usePathname();
  useEffect(() => { if (pathname) send("page_view"); }, [pathname]);
  useEffect(() => {
    // The column matters: production scripts are one line long.
    const failed = (event: ErrorEvent) => reportError("error", event.error ?? event.message,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : thrownAt(event.error));
    const rejected = (event: PromiseRejectionEvent) => reportError("promise", event.reason, thrownAt(event.reason));
    window.addEventListener("error", failed);
    window.addEventListener("unhandledrejection", rejected);
    return () => { window.removeEventListener("error", failed); window.removeEventListener("unhandledrejection", rejected); };
  }, []);
  return null;
}
