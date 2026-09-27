import type { Plan } from "./server/billing";

const zeroDecimal = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

/** An amount in the smallest currency unit, without cents when there are none: "$8", "$2.50". */
export function formatMoney(amount: number, currency: string) {
  const value = zeroDecimal.has(currency) ? amount : amount / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
}

/** "a month", "every 3 months" */
export function formatPeriod(interval: string, count = 1) {
  return count === 1 ? `a ${interval}` : `every ${count} ${interval}s`;
}

/** "$2 a month for each space", "$8 a month" */
export function formatPlanPrice(plan: Pick<Plan, "amount" | "currency" | "interval" | "intervalCount" | "spaces">) {
  return `${formatMoney(plan.amount, plan.currency)} ${formatPeriod(plan.interval, plan.intervalCount)}${plan.spaces === null ? " for each space" : ""}`;
}
