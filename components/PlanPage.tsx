"use client";

import { useState } from "react";
import { accountRequest } from "./AccountAuth";
import { accountNav, legalLinks, openPortal } from "./AccountDashboard";
import PlanPicker, { currentPlan, EnterpriseNote, hostingActive, OpenSourceNote, periodTotal } from "./PlanPicker";
import SiteHeader from "./site/SiteHeader";
import SpaceUsage from "./site/SpaceUsage";
import { SiteFooter } from "./site/Chrome";
import type { Plan } from "@/lib/server/billing";
import type { AccountView } from "@/lib/server/customer-spaces";
import { formatMoney, formatPeriod } from "@/lib/price";

function formatDate(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

const previewDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

const price = (plan: Plan) => `${formatMoney(plan.amount, plan.currency)} ${formatPeriod(plan.interval, plan.intervalCount)}`;
const planLabel = (plan: Plan) => plan.spaces === null ? "pay as you go" : plan.name;

/**
 * Choosing how hosting is paid for. Before hosting starts this leads to Checkout on the
 * chosen plan; afterwards it switches the subscription between plans. From the tour builder
 * (`build`), for the agent's drafts, it comes before any space: pay as you go only saves a card then.
 * From a tour's class results (`results`), it also comes before any space; the page offers only
 * the plans that show every player (pay as you go bills nothing until there is a space, so it can't).
 * From a space's page (`forSpace`), it publishes a free preview or keeps it: Checkout returns to that space.
 * From the pricing page (`picked`), that plan is chosen already, and a plan covering a set number of
 * spaces can be paid for before any space. From a list of Matterport spaces coming over (`forImport`),
 * Checkout returns to the list, whose waiting spaces then start.
 */
export default function PlanPage({ account: initial, plans, brand, build, results, forSpace, forImport, picked }: { account: AccountView; plans: Plan[]; brand: string; build?: string;
  /** The customer's tour whose class results they came to see in full. */ results?: string;
  /** The space being published or kept after its free preview. */ forSpace?: { id: string; title: string; until: string | null; expired: boolean };
  /** The list of Matterport spaces waiting for hosting or for room in the plan. */ forImport?: { id: string; waiting: number };
  /** The plan chosen on the pricing page. */ picked?: string }) {
  const [account, setAccount] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const subscription = account.subscription;
  const active = hostingActive(account);
  const forResults = Boolean(results) && !active;
  const paused = Boolean(subscription && !active && ["unpaid", "incomplete", "paused"].includes(subscription.status));
  const current = active ? currentPlan(plans, subscription) : undefined;
  const spaces = account.spaceCount;
  // A plan has to cover every space the account has; the picker shows smaller ones as too small.
  const fits = (plan: Plan) => plan.spaces === null || plan.spaces >= Math.max(spaces, 1);
  const pickedPlan = plans.find(plan => plan.id === picked);
  const [choice, setChoice] = useState<string | null>(pickedPlan && fits(pickedPlan) ? pickedPlan.id : null);
  const selected = plans.find(plan => plan.id === choice) ?? current ?? plans.find(fits) ?? plans[0];
  // Before any space, a plan covering a set number of spaces is paid for now; pay as you go waits for a space.
  const upfront = spaces === 0 && Boolean(selected && selected.spaces !== null);

  async function run(work: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  const pay = () => run(async () => {
    const result = await accountRequest("/api/account/billing/checkout", { plan: selected?.id, ...results ? { results } : build ? { build } : forSpace ? { space: forSpace.id }
      : forImport ? { import: forImport.id } : {} });
    // Without a link, a payment made earlier was just applied.
    window.location.assign(result.url ?? "/account");
  });
  const change = () => run(async () => {
    const result = await accountRequest("/api/account/billing/plan", { plan: selected!.id });
    setAccount(result.account);
    setChoice(null);
    setMessage(`You're on ${planLabel(selected!)} now.${forImport ? " The spaces waiting on your list start coming over again." : ""}`);
  });
  const portal = () => run(openPortal);

  const total = active && subscription ? periodTotal(subscription) : undefined;
  const building = (Boolean(build) || forResults) && !active && !paused;
  const perSpace = plans.find(plan => plan.spaces === null);
  const saveCard = building && spaces === 0 && selected?.spaces === null;
  const team = account.team;
  const canManageBilling = (!team || team.role === "owner") && !team?.invoiced;
  let lead: string;
  if (team?.invoiced) {
    lead = `${team.name} is on an invoiced ${team.planName ?? "Enterprise"} plan${team.planSpaces ? ` covering up to ${team.planSpaces} spaces` : ""}. Your team is using ${spaces} ${spaces === 1 ? "space" : "spaces"}.`;
  } else if (team && team.role !== "owner") {
    lead = `Billing for ${team.name} is managed by the team owner.`;
  } else if (building && forResults) {
    lead = "Every plan shows all your players, with how far each one got, and lets you download them. With a plan the agent also drafts your tours and hunts as often as you like.";
  } else if (building) {
    lead = `Building tours and scavenger hunts by hand is free. With a plan the agent drafts them for you as often as you like.${perSpace ? ` Pay as you go costs nothing until you host a space of your own, then ${price(perSpace)} for each.` : ""}`;
  } else if (active && current) {
    lead = current.spaces === null ? `You're on pay as you go with ${spaces} ${spaces === 1 ? "space" : "spaces"}${total ? `, ${total}` : ""}.`
      : `You're on ${current.name} at ${price(current)}, which covers ${current.spaces === 1 ? "one space" : `up to ${current.spaces} spaces`}. You have ${spaces}.`;
  } else if (active) lead = "Your plan is not offered any more. You can keep it or choose another below.";
  else if (paused) lead = "Hosting is paused until a payment goes through. Update your payment method to change plans.";
  else if (forImport) {
    lead = `Start hosting to bring over the ${forImport.waiting === 1 ? "Matterport space" : `${forImport.waiting} Matterport spaces`} waiting on your list.${perSpace ? ` Pay as you go is ${price(perSpace)} for each space, and a plan covers a set number for one price.` : ""}`;
  } else if (forSpace) {
    lead = forSpace.expired ? `${forSpace.title} is offline because its free preview ended. Start hosting to bring it back, with the same link.`
      : `Start hosting to make ${forSpace.title} public with a link you can share and an embed, or to keep it after its free preview${forSpace.until ? ` ends on ${previewDate(forSpace.until)}` : ""}.${perSpace ? ` Pay as you go is ${price(perSpace)} for each space.` : ""}`;
  } else if (spaces === 0 && plans.length > 1) {
    lead = `Building tours and scavenger hunts is free. A plan shows every player in your class results, lets the agent draft as often as you like, and covers a set number of spaces of your own.${perSpace ? ` Pay as you go is ${price(perSpace)} for each space you host.` : ""}`;
  } else {
    lead = perSpace ? `Pay as you go is ${price(perSpace)} for each space you host.${plans.length > 1 ? " A plan covers a set number of spaces for one price." : ""}${account.preview?.available ? " Your first capture is a free private preview, so you pay when you publish it or keep it." : ""}`
      : "Plans could not be loaded. Try again in a moment.";
  }
  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={accountNav(account, "plan")} account={account.email} signOut="account" />
    <main className="site-main">
      {forImport ? <a className="site-back" href={`/account/import/${forImport.id}`}>← Your Matterport list</a> : <a className="site-back" href="/account">← Your spaces</a>}
      <div className="site-title">
        <div><h1>{building ? forResults ? "Choose a plan to see every player" : "Choose a plan for the agent" : active ? "Your plan" : subscription && !paused ? "Restart hosting"
          : spaces === 0 ? "Choose a plan" : "Start hosting"}</h1></div>
        {active && subscription?.periodEnd ? <p>{subscription.cancelAtPeriodEnd ? "Hosting ends" : "Renews"} {formatDate(subscription.periodEnd)}</p> : null}
      </div>
      {canManageBilling && (spaces > 0 || active) && <div className="plan-usage">
        <SpaceUsage used={spaces} limit={active ? subscription?.plan?.spaces ?? null : null} plan={active ? current?.name ?? null : null} />
      </div>}
      <p className="plan-lead">{lead}</p>
      {pickedPlan && !fits(pickedPlan) && <p className="site-note" role="status">
        {pickedPlan.name} covers {pickedPlan.spaces === 1 ? "1 space" : `up to ${pickedPlan.spaces} spaces`} and you have {spaces}, so it can&apos;t be chosen. Plans that fit are below.</p>}
      <div className="site-feedback" aria-live="polite">
        {message && <p className="site-note" role="status">{message}</p>}
        {error && <p className="site-alert" role="alert">{error}</p>}
      </div>

      {!canManageBilling ? <div className="site-actions">
        <a className="site-button" href="/account/team">Team settings<span aria-hidden="true">→</span></a>
      </div> : paused ? <div className="site-actions">
        <button type="button" className="site-button" disabled={busy} onClick={portal}>{busy ? "Opening…" : "Update payment method"}</button>
      </div> : plans.length > 0 && <>
        <PlanPicker plans={plans} selected={selected?.id ?? null} onSelect={setChoice} needed={Math.max(spaces, 1)} current={current?.id}
          name="plan" label="Plans" disabled={busy} />
        <div className="plan-actions">
          {active ? <>
            <button type="button" className="site-button" disabled={busy || !selected || selected.id === current?.id || !fits(selected)} onClick={change}>
              {busy ? "Changing plans…" : selected && selected.id !== current?.id ? `Switch to ${planLabel(selected)}` : "Choose another plan"}</button>
            <button type="button" className="site-link" disabled={busy} onClick={portal}>Billing and invoices</button>
          </> : spaces > 0 || building || upfront ? <button type="button" className="site-button site-button-accent" disabled={busy || !selected || !fits(selected)} onClick={pay}>
            {busy ? "Opening payment…" : saveCard ? "Add a card" : "Continue to payment"}<span aria-hidden="true">→</span></button>
          : <a className="site-button" href="/account">Add a space<span aria-hidden="true">→</span></a>}
        </div>
        <p className="site-hint plan-hint">{active ? "A change applies now, and your next invoice is prorated for the rest of this period."
          : saveCard ? "Your card is saved on a secure page and nothing is charged today. Then you go straight to building."
          : building && forResults ? "You pay on a secure checkout page and can cancel any time. Then you're back at your class results."
          : building ? "You pay on a secure checkout page and can cancel any time. Then you go straight to building."
          : forSpace ? "You pay on a secure checkout page, can cancel any time, and come back to your space afterwards."
          : forImport && spaces > 0 ? "You pay on a secure checkout page and can cancel any time. Then you're back at your list, and its spaces start coming over."
          : spaces > 0 || upfront ? "You pay on a secure checkout page and can cancel any time."
          : account.preview?.available ? "Nothing to pay yet. Your first capture is a free private preview, and you pay when you publish it or keep it."
          : "You pay once you add your first space."}</p>
        <EnterpriseNote email={account.salesEmail} />
        <OpenSourceNote brand={brand} sourceUrl={account.sourceUrl} />
      </>}
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
  </div></div>;
}
