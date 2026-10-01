"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Sends page views and the steps people take to the site's own analytics (see
// lib/server/analytics.ts), and the same events to Google Analytics when it is loaded.

type Props = Record<string, string | number | boolean>;
declare global { interface Window { gtag?: (...args: unknown[]) => void } }

const enabled = process.env.NEXT_PUBLIC_SPHR_ANALYTICS === "1";
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
  try { if (navigator.sendBeacon?.("/api/analytics", body)) return; } catch { /* falls back to fetch */ }
  void fetch("/api/analytics", { method: "POST", body, keepalive: true }).catch(() => undefined);
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

export default function Analytics() {
  const pathname = usePathname();
  useEffect(() => { if (pathname) send("page_view"); }, [pathname]);
  return null;
}
