"use client";

import { useState } from "react";
import { accountRequest } from "./AccountAuth";
import { accountNav, legalLinks, openPortal } from "./AccountDashboard";
import PlanPicker, { currentPlan, EnterpriseNote, hostingActive, OpenSourceNote, periodTotal } from "./PlanPicker";
import SiteHeader from "./site/SiteHeader";
import { SiteFooter } from "./site/Chrome";
import type { Plan } from "@/lib/server/billing";
import type { AccountView } from "@/lib/server/customer-spaces";
import { formatMoney, formatPeriod } from "@/lib/price";

function formatDate(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

const price = (plan: Plan) => `${formatMoney(plan.amount, plan.currency)} ${formatPeriod(plan.interval, plan.intervalCount)}`;
const planLabel = (plan: Plan) => plan.spaces === null ? "pay as you go" : plan.name;

/**
 * Choosing how hosting is paid for. Before hosting starts this leads to Checkout on the
 * chosen plan; afterwards it switches the subscription between plans. On the way to building
 * a tour (`build`), it comes before any space: pay as you go only saves a card then.
 */
export default function PlanPage({ account: initial, plans, brand, build }: { account: AccountView; plans: Plan[]; brand: string; build?: string }) {
  const [account, setAccount] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const subscription = account.subscription;
  const active = hostingActive(account);
  const paused = Boolean(subscription && !active && ["unpaid", "incomplete", "paused"].includes(subscription.status));
  const current = active ? currentPlan(plans, subscription) : undefined;
  const [choice, setChoice] = useState<string | null>(null);
  const selected = plans.find(plan => plan.id === choice) ?? current ?? plans[0];
  const spaces = account.spaceCount;

  async function run(work: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  const pay = () => run(async () => {
    const result = await accountRequest("/api/account/billing/checkout", { plan: selected?.id, ...build ? { build } : {} });
    // Without a link, a payment made earlier was just applied.
    window.location.assign(result.url ?? "/account");
  });
  const change = () => run(async () => {
    const result = await accountRequest("/api/account/billing/plan", { plan: selected!.id });
    setAccount(result.account);
    setChoice(null);
    setMessage(`You're on ${planLabel(selected!)} now.`);
  });
  const portal = () => run(openPortal);

  const total = active && subscription ? periodTotal(subscription) : undefined;
  const building = Boolean(build) && !active && !paused;
  const perSpace = plans.find(plan => plan.spaces === null);
  const saveCard = building && spaces === 0 && selected?.spaces === null;
  let lead: string;
  if (building) {
    lead = `Tours and scavenger hunts are free on every plan.${perSpace ? ` Pay as you go costs nothing until you host a space of your own, then ${price(perSpace)} for each.` : ""}`;
  } else if (active && current) {
    lead = current.spaces === null ? `You're on pay as you go with ${spaces} ${spaces === 1 ? "space" : "spaces"}${total ? `, ${total}` : ""}.`
      : `You're on ${current.name} at ${price(current)}, which covers up to ${current.spaces} spaces. You have ${spaces}.`;
  } else if (active) lead = "Your plan is not offered any more. You can keep it or choose another below.";
  else if (paused) lead = "Hosting is paused until a payment goes through. Update your payment method to change plans.";
  else {
    lead = perSpace ? `You're on pay as you go, so each space you upload adds ${price(perSpace)}.${plans.length > 1 ? " A plan covers a set number of spaces for one price." : ""}`
      : "Plans could not be loaded. Try again in a moment.";
  }
  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={accountNav(account, "plan")} account={account.email} signOut="account" />
    <main className="site-main">
      <a className="site-back" href="/account">← Your spaces</a>
      <div className="site-title">
        <div><h1>{building ? "Choose a plan to start building" : active ? "Your plan" : subscription && !paused ? "Restart hosting" : "Start hosting"}</h1></div>
        {active && subscription?.periodEnd ? <p>{subscription.cancelAtPeriodEnd ? "Hosting ends" : "Renews"} {formatDate(subscription.periodEnd)}</p> : null}
      </div>
      <p className="plan-lead">{lead}</p>
      <div className="site-feedback" aria-live="polite">
        {message && <p className="site-note" role="status">{message}</p>}
        {error && <p className="site-alert" role="alert">{error}</p>}
      </div>

      {paused ? <div className="site-actions">
        <button type="button" className="site-button" disabled={busy} onClick={portal}>{busy ? "Opening…" : "Update payment method"}</button>
      </div> : plans.length > 0 && <>
        <PlanPicker plans={plans} selected={selected?.id ?? null} onSelect={setChoice} needed={Math.max(spaces, 1)} current={current?.id}
          name="plan" label="Plans" disabled={busy} />
        <div className="plan-actions">
          {active ? <>
            <button type="button" className="site-button" disabled={busy || !selected || selected.id === current?.id} onClick={change}>
              {busy ? "Changing plans…" : selected && selected.id !== current?.id ? `Switch to ${planLabel(selected)}` : "Choose another plan"}</button>
            <button type="button" className="site-link" disabled={busy} onClick={portal}>Billing and invoices</button>
          </> : spaces > 0 || building ? <button type="button" className="site-button site-button-accent" disabled={busy || !selected} onClick={pay}>
            {busy ? "Opening payment…" : saveCard ? "Add a card" : "Continue to payment"}<span aria-hidden="true">→</span></button>
          : <a className="site-button" href="/account">Add a space<span aria-hidden="true">→</span></a>}
        </div>
        <p className="site-hint plan-hint">{active ? "A change applies now, and your next invoice is prorated for the rest of this period."
          : saveCard ? "Your card is saved on a secure page and nothing is charged today. Then you go straight to building."
          : building ? "You pay on a secure checkout page and can cancel any time. Then you go straight to building."
          : spaces > 0 ? "You pay on a secure checkout page and can cancel any time."
          : "You pay once you add your first space."}</p>
        <EnterpriseNote email={account.salesEmail} />
        <OpenSourceNote brand={brand} sourceUrl={account.sourceUrl} />
      </>}
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
  </div></div>;
}
