"use client";

import type { CSSProperties } from "react";
import type { Plan } from "@/lib/server/billing";
import type { AccountView } from "@/lib/server/customer-spaces";
import { formatMoney, formatPeriod } from "@/lib/price";

type Subscription = NonNullable<AccountView["subscription"]>;

export const hostingActive = (account: AccountView) => Boolean(account.subscription && ["active", "trialing", "past_due"].includes(account.subscription.status));

/** The offered plan a subscription pays for: its price, or else pay as you go or the plan covering the same spaces. */
export function currentPlan(plans: Plan[], subscription: Subscription | null) {
  const paid = subscription?.plan;
  if (!paid) return subscription ? plans.find(plan => plan.spaces === null) : undefined;
  return plans.find(plan => plan.id === paid.price) ?? plans.find(plan => plan.spaces === paid.spaces);
}

/** What a subscription costs each period, "$14 a month", when its price is known. Prorations for changes come on top. */
export function periodTotal(subscription: Subscription) {
  const plan = subscription.plan;
  if (!plan || plan.amount === null) return undefined;
  return `${formatMoney(plan.spaces === null ? plan.amount * subscription.quantity : plan.amount, plan.currency)} ${formatPeriod(plan.interval, plan.intervalCount)}`;
}

/** The smallest plan that covers these spaces for less than paying for each of them. */
export function cheaperPlan(plans: Plan[], spaces: number) {
  const perSpace = plans.find(plan => plan.spaces === null);
  if (!perSpace || !spaces) return undefined;
  return plans.find(plan => plan.spaces !== null && plan.spaces >= spaces && plan.currency === perSpace.currency
    && plan.interval === perSpace.interval && plan.intervalCount === perSpace.intervalCount && plan.amount < perSpace.amount * spaces);
}

/**
 * The ways to pay for hosting as a row of cards: pay as you go, then plans that cover a set
 * number of spaces. Plans too small for `needed` spaces stay visible but cannot be chosen.
 */
export default function PlanPicker({ plans, selected, onSelect, needed, current, name, label, disabled = false }: {
  plans: Plan[];
  selected: string | null;
  onSelect: (id: string) => void;
  /** Spaces the chosen plan has to cover. */
  needed: number;
  /** The plan the customer is on, marked as such. */
  current?: string | null;
  name: string;
  label: string;
  disabled?: boolean;
}) {
  return <fieldset className="plan-picker" disabled={disabled}>
    <legend className="plan-picker-legend">{label}</legend>
    <div className="plan-options" style={{ "--plans": plans.length } as CSSProperties}>
      {plans.map(plan => {
        const fits = plan.spaces === null || plan.spaces >= needed;
        const chosen = selected === plan.id;
        return <label key={plan.id} className={`plan-option${chosen ? " plan-option-selected" : ""}${fits ? "" : " plan-option-small"}`}>
          <input type="radio" name={name} value={plan.id} checked={chosen} disabled={!fits} onChange={() => onSelect(plan.id)}
            aria-label={`${plan.name}, ${formatMoney(plan.amount, plan.currency)} ${formatPeriod(plan.interval, plan.intervalCount)}${plan.spaces === null ? " for each space" : ` for up to ${plan.spaces} spaces`}`} />
          <span className="plan-option-name"><i aria-hidden="true" /><span>{plan.name}</span>
            {current === plan.id ? <em>Your plan</em> : !fits && <em>Too small</em>}</span>
          <span className="plan-option-price"><b>{formatMoney(plan.amount, plan.currency)}</b>
            <span>{formatPeriod(plan.interval, plan.intervalCount)}{plan.spaces === null ? " for each space" : ""}</span></span>
          <span className="plan-option-detail">{plan.spaces === null ? "Charged as you upload" : `Up to ${plan.spaces} spaces`}</span>
        </label>;
      })}
    </div>
  </fieldset>;
}

/** Shown where people choose how to pay, when the deployment publishes its source. */
export function OpenSourceNote({ brand, sourceUrl }: { brand: string; sourceUrl: string | null }) {
  if (!sourceUrl) return null;
  return <p className="plan-note">
    {brand} is <a href={sourceUrl} target="_blank" rel="noreferrer">open source software</a>. Hosting your spaces here supports its
    continued development and keeps virtual tour hosting affordable for good.
  </p>;
}
