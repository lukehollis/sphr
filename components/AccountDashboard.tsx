"use client";

import { useState, type FormEvent } from "react";
import { accountRequest } from "./AccountAuth";
import SiteHeader from "./site/SiteHeader";
import { ConstructionDrawing, SectionHeader, SiteFooter, StatusMark } from "./site/Chrome";
import type { AccountView, SpaceView } from "@/lib/server/customer-spaces";
import type { PriceSummary } from "@/lib/server/billing";
import { formatPrice } from "@/lib/price";

export { formatPrice };

export const statusLabels: Record<string, string> = {
  unpaid: "Waiting for payment", draft: "Add files", queued: "Submitted", processing: "Processing",
  ready: "Ready", failed: "Needs attention"
};

export const legalLinks = [{ href: "/terms", label: "Terms" }, { href: "/privacy", label: "Privacy" }];

export function formatDate(seconds: number | null) {
  return seconds ? new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
}

function shortDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function money(amount: number, currency: string) {
  const zeroDecimal = new Set(["jpy", "krw", "vnd", "clp", "pyg", "ugx", "xaf", "xof"]);
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(zeroDecimal.has(currency) ? amount : amount / 100);
}

export async function openBilling(kind: "checkout" | "portal") {
  const { url } = await accountRequest(`/api/account/billing/${kind}`);
  // Without a URL, an earlier payment was just applied.
  if (url) window.location.assign(url); else window.location.reload();
}

/** The status a space shows on its card. */
export function spaceStatus(space: SpaceView) {
  if (!space.hosted && space.status !== "unpaid") return "offline";
  if (space.status === "ready" && space.scene) return space.scene.public ? "public" : "private";
  return space.status;
}

/** Billing figures across the top of the page, and a call to action when billing needs attention. */
function BillingSummary({ account, spaces, price }: { account: AccountView; spaces: SpaceView[]; price?: PriceSummary }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const subscription = account.subscription;
  const active = Boolean(subscription && ["active", "trialing", "past_due"].includes(subscription.status));
  const unpaid = spaces.some(space => space.status === "unpaid");
  async function go(kind: "checkout" | "portal") {
    setBusy(true); setError("");
    try { await openBilling(kind); } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  let alert = "", action: ["checkout" | "portal", string] | undefined;
  if (subscription && ["unpaid", "incomplete", "paused"].includes(subscription.status)) {
    alert = "Hosting is paused until a payment goes through. Update your payment method to bring your spaces back online.";
    action = ["portal", "Update payment method"];
  } else if (!active && spaces.length && (unpaid || subscription)) {
    alert = subscription ? "Hosting is paused because billing ended. Restart billing to bring your spaces back online." : "Complete payment to start uploading.";
    action = ["checkout", subscription ? "Restart billing" : "Complete payment"];
  } else if (subscription?.status === "past_due") {
    alert = "Your last payment did not go through. Update your payment method to keep your spaces online.";
    action = ["portal", "Update payment method"];
  } else if (active) action = ["portal", "Billing and invoices"];
  const hosted = spaces.filter(space => space.status !== "unpaid").length;
  const total = price && active && subscription ? money(price.amount * subscription.quantity, price.currency) : null;
  return <>
    <dl className="site-stats">
      <div><dt>Spaces</dt><dd>{hosted}</dd></div>
      {account.billing && <div><dt>Price</dt><dd>{price ? formatPrice(price).replace(" per space per ", " / space / ") : "—"}</dd></div>}
      {account.billing && <div><dt>{subscription?.cancelAtPeriodEnd ? "Billing ends" : "Next invoice"}</dt>
        <dd>{active && subscription?.periodEnd ? <>{formatDate(subscription.periodEnd)}{total && <small>{total}</small>}</> : "—"}</dd></div>}
      {account.billing && action && <div className="site-stats-action">
        <button type="button" className={`site-button${alert ? "" : " site-button-secondary"}`} disabled={busy} onClick={() => go(action[0])}>{busy ? "Opening…" : action[1]}</button>
      </div>}
    </dl>
    {alert && <p className="site-callout" role="status">{alert}</p>}
    {error && <p className="site-alert" role="alert">{error}</p>}
  </>;
}

export function SpaceCard({ space }: { space: SpaceView }) {
  const files = space.uploads.length;
  return <a className="site-card" href={`/account/spaces/${space.id}`} aria-label={`Manage ${space.title}`}>
    <div className="site-card-media">
      {space.scene ? <img src={space.scene.thumbnail} alt="" loading="lazy" width={960} height={640} />
        : <span className="site-card-letter" aria-hidden="true">{space.title.slice(0, 1)}</span>}
      <span className="site-card-tag"><StatusMark status={spaceStatus(space)} /></span>
    </div>
    <div className="site-card-body">
      <h3>{space.title}</h3>
      <p>{files} {files === 1 ? "file" : "files"} · Added {shortDate(space.created)}</p>
    </div>
  </a>;
}

export default function AccountDashboard({ account, spaces, price, notice, brand }:
  { account: AccountView; spaces: SpaceView[]; price?: PriceSummary; notice?: string; brand: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(notice ?? "");
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await accountRequest("/api/account/spaces", { title: form.get("title") });
      if (result.checkout || result.portal) { window.location.assign(result.checkout ?? result.portal); return; }
      window.location.assign(`/account/spaces/${result.space.id}`);
    } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  async function resend() {
    setError(""); setMessage("");
    try { await accountRequest("/api/account/verify/resend"); setMessage(`We sent a new link to ${account.email}.`); }
    catch (failure) { setError((failure as Error).message); }
  }
  const active = account.subscription && ["active", "trialing", "past_due"].includes(account.subscription.status);
  const blocked = !account.emailVerified;
  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={[{ href: "/account", label: "Your spaces", current: true }]} account={account.email} signOut="account" />
    <main className="site-main">
      <div className="site-title">
        <div><span className="site-code">01</span><h1>Your spaces</h1></div>
        <p>Upload a capture and it becomes a space you can share.</p>
      </div>
      <div className="site-feedback" aria-live="polite">
        {message && <p className="site-note" role="status">{message}</p>}
        {error && <p className="site-alert" role="alert">{error}</p>}
      </div>
      {blocked && <div className="site-callout site-callout-action">
        <p>Confirm your email address to add spaces. We sent a link to <strong>{account.email}</strong>.</p>
        <button type="button" className="site-button site-button-secondary" onClick={resend}>Send a new link</button>
      </div>}
      <BillingSummary account={account} spaces={spaces} price={price} />

      <section className="site-block" aria-labelledby="new-space">
        <SectionHeader title={<span id="new-space">New space</span>} code="1.0" />
        <form className="site-inline-form" onSubmit={create}>
          <div className="site-field">
            <label htmlFor="space-title">Title</label>
            <input className="site-input" id="space-title" name="title" required maxLength={200} placeholder="Riverside studio" disabled={blocked} />
          </div>
          <button className="site-button" type="submit" disabled={busy || blocked}>{busy ? "Adding…" : account.billing && !active ? "Add and pay" : "Add space"}<span aria-hidden="true">→</span></button>
        </form>
        {account.billing && price && <p className="site-hint">{active ? `Adds ${formatPrice(price).replace(" per space", "")}, prorated for this period.`
          : `Checkout opens next. ${formatPrice(price)}. Delete a space any time.`}</p>}
      </section>

      <section className="site-block" aria-labelledby="space-list">
        <SectionHeader title={<span id="space-list">Spaces</span>} code="2.0">{spaces.length > 0 && <span className="site-count">{spaces.length}</span>}</SectionHeader>
        {spaces.length ? <div className="site-grid">{spaces.map(space => <SpaceCard key={space.id} space={space} />)}</div>
          : <div className="site-empty">
            <ConstructionDrawing />
            <div><h3>No spaces yet</h3><p>Add a space, upload your capture files, and it is processed and hosted for you.</p></div>
          </div>}
      </section>
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
  </div></div>;
}
