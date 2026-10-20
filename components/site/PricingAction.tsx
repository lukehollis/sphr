"use client";

import { useState } from "react";
import { accountRequest } from "../AccountAuth";

export type PricingActionProps = {
  label: string;
  variant: "accent" | "ink" | "outline";
  /** Opens Checkout for this price straight away (a signed-in customer who can pay). */
  checkout?: string;
  /** Where the button leads otherwise: sign-up, the plan page, or building. */
  href?: string;
  /** A plan too small for the account's spaces: the button says so and leads nowhere. */
  disabled?: boolean;
};

/**
 * A plan's button on the pricing page. Signed-in customers who can pay go straight to Checkout;
 * everyone else follows a link (sign-up first, then the plan page with that plan chosen).
 */
export default function PricingAction({ label, variant, checkout, href, disabled = false }: PricingActionProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const className = `site-button site-button-block${variant === "accent" ? " site-button-accent" : variant === "outline" ? " site-button-secondary" : ""}`;
  if (disabled) return <button type="button" className="site-button site-button-block" disabled>{label}</button>;
  if (!checkout) return <a className={className} href={href}>{label}<span aria-hidden="true">→</span></a>;
  async function pay() {
    setBusy(true); setError("");
    try {
      const result = await accountRequest("/api/account/billing/checkout", { plan: checkout, source: "pricing" });
      // Without a link, a payment made earlier was just applied.
      window.location.assign(result.url ?? "/account");
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }
  return <>
    <button type="button" className={className} disabled={busy} onClick={pay}>{busy ? "Opening checkout…" : label}<span aria-hidden="true">→</span></button>
    {error && <p className="site-alert pricing-error" role="alert">{error} <a href={`/account/plan?plan=${checkout}`}>Choose on the plan page</a></p>}
  </>;
}
