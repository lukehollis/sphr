import { siteBrand } from "./brand";
import { formatBytes } from "../bytes";
import type { Plan } from "./billing";
import type { SubscriptionPlan } from "./accounts-store";

// Operator notifications. With SPHR_DISCORD_WEBHOOK_URL set, the operator's Discord channel hears
// about sign-ups, spaces, submissions, processing results, linked agents and billing changes.
// Best effort: delivery runs after the request and a failure is only logged.

type Tone = "info" | "good" | "money" | "warn" | "bad";
export type TeamEvent = { title: string; tone?: Tone; description?: string; url?: string; fields?: [string, string | number | null | undefined][] };

const colors: Record<Tone, number> = { info: 0x111111, good: 0x2f7d4f, money: 0xe03c31, warn: 0xc98a00, bad: 0x9e2a22 };
const webhook = () => process.env.SPHR_DISCORD_WEBHOOK_URL?.trim() || undefined;
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export function teamNotificationsEnabled() {
  return Boolean(webhook());
}

// Discord allows a few messages a second per webhook, so events go out one at a time.
let queue: Promise<void> = Promise.resolve();

export function notifyTeam(event: TeamEvent) {
  const url = webhook();
  if (!url) return Promise.resolve();
  const embed = {
    title: clip(event.title, 256),
    color: colors[event.tone ?? "info"],
    ...(event.description ? { description: clip(event.description, 2000) } : {}),
    ...(event.url ? { url: event.url } : {}),
    fields: (event.fields ?? []).filter(([, value]) => value !== undefined && value !== null && value !== "").slice(0, 20)
      .map(([name, value]) => ({ name: clip(name, 256), value: clip(String(value), 1000), inline: String(value).length <= 40 })),
    timestamp: new Date().toISOString()
  };
  // Customer-supplied text (titles, names) must never ping anyone.
  const body = JSON.stringify({ username: siteBrand(), embeds: [embed], allowed_mentions: { parse: [] } });
  queue = queue.then(() => deliver(url, body)).catch(error => console.error("Unable to notify the team:", error instanceof Error ? error.message : error));
  return queue;
}

async function deliver(url: string, body: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(10000) });
    if (response.ok) return;
    if (response.status !== 429 && response.status < 500) throw new Error(`Webhook answered HTTP ${response.status}`);
    const wait = Number((await response.json().catch(() => ({})) as { retry_after?: number }).retry_after ?? 2);
    await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(0.5, wait)) * 1000));
  }
  throw new Error("Webhook kept refusing the message.");
}

export function describePrice(plan: SubscriptionPlan | null | undefined, plans: Plan[] = []) {
  if (!plan) return "Unknown plan";
  const name = plans.find(item => item.id === plan.price)?.name ?? (plan.spaces ? `Plan for ${plan.spaces} spaces` : "Pay as you go");
  const amount = plan.amount === null ? "" : `${new Intl.NumberFormat("en-US", { style: "currency", currency: plan.currency.toUpperCase() }).format(plan.amount / 100)}`
    + ` a ${plan.intervalCount > 1 ? `${plan.intervalCount} ${plan.interval}s` : plan.interval}${plan.spaces ? "" : " per space"}`;
  return amount ? `${name}, ${amount}` : name;
}

export function filesSummary(files: { size: number }[]) {
  return `${files.length} file${files.length === 1 ? "" : "s"}, ${formatBytes(files.reduce((total, file) => total + file.size, 0))}`;
}
