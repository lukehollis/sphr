import type { PriceSummary } from "./server/billing";

const zeroDecimal = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

export function formatPrice(price: PriceSummary) {
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: price.currency })
    .format(zeroDecimal.has(price.currency) ? price.amount : price.amount / 100);
  const period = price.intervalCount === 1 ? price.interval : `${price.intervalCount} ${price.interval}s`;
  return `${amount} per space per ${period}`;
}
