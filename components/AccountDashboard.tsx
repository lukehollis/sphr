"use client";

import { useState, type FormEvent } from "react";
import { accountRequest } from "./AccountAuth";
import type { AccountView, SpaceView } from "@/lib/server/customer-spaces";
import type { PriceSummary } from "@/lib/server/billing";
import { formatPrice } from "@/lib/price";

export { formatPrice };

export const statusLabels: Record<string, string> = {
  unpaid: "Waiting for payment", draft: "Add files", queued: "Submitted", processing: "Processing",
  ready: "Ready", failed: "Needs attention"
};

export function formatDate(seconds: number | null) {
  return seconds ? new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
}

export async function openBilling(kind: "checkout" | "portal") {
  const { url } = await accountRequest(`/api/account/billing/${kind}`);
  // Without a URL, an earlier payment was just applied.
  if (url) window.location.assign(url); else window.location.reload();
}

export function AccountHeader({ title, back }: { title: string; back?: { href: string; label: string } }) {
  const [error, setError] = useState("");
  async function logout() {
    try { await accountRequest("/api/account/logout"); window.location.assign("/account/login"); }
    catch (failure) { setError((failure as Error).message); }
  }
  return <header className="admin-header account-header">
    <div>{back && <a className="account-back" href={back.href}>← {back.label}</a>}<h1>{title}</h1></div>
    <nav aria-label="Account">{error && <span role="alert">{error}</span>}<button onClick={logout}>Sign out</button></nav>
  </header>;
}

export function BillingNotice({ account, spaces, price }: { account: AccountView; spaces: SpaceView[]; price?: PriceSummary }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!account.billing) return null;
  const subscription = account.subscription;
  const active = subscription && ["active", "trialing", "past_due"].includes(subscription.status);
  const unpaid = spaces.some(space => space.status === "unpaid");
  async function go(kind: "checkout" | "portal") {
    setBusy(true); setError("");
    try { await openBilling(kind); } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  let text = "", action: ["checkout" | "portal", string] | undefined;
  if (subscription && ["unpaid", "incomplete", "paused"].includes(subscription.status)) {
    text = "Hosting is paused until a payment goes through. Update your payment method to bring your spaces back online.";
    action = ["portal", "Update payment method"];
  } else if (!active && spaces.length && (unpaid || subscription)) {
    text = subscription ? "Hosting is paused because billing ended. Restart billing to bring your spaces back online." : "Complete payment to start uploading.";
    action = ["checkout", subscription ? "Restart billing" : "Complete payment"];
  } else if (subscription?.status === "past_due") {
    text = "Your last payment did not go through. Update your payment method to keep your spaces online.";
    action = ["portal", "Update payment method"];
  } else if (active) {
    const count = `${subscription.quantity} ${subscription.quantity === 1 ? "space" : "spaces"}`;
    text = subscription.cancelAtPeriodEnd ? `${count}. Billing ends on ${formatDate(subscription.periodEnd)}; your spaces go offline then.`
      : `${count}${subscription.periodEnd ? `. Next invoice ${formatDate(subscription.periodEnd)}` : ""}.`;
    action = ["portal", "Billing and invoices"];
  }
  return <section className="account-billing" aria-label="Billing">
    <p>{price ? <strong>{formatPrice(price)}</strong> : null}{text && <span>{text}</span>}</p>
    {action && <button type="button" disabled={busy} onClick={() => go(action[0])}>{busy ? "Opening…" : action[1]}</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function SpaceCard({ space }: { space: SpaceView }) {
  return <article className="space-card account-space-card">
    <a className="space-card-link" href={`/account/spaces/${space.id}`} aria-label={`Manage ${space.title}`}>
      <div className="scene-thumbnail">{space.scene ? <img src={space.scene.thumbnail} alt="" loading="lazy" width={960} height={640} />
        : <span className="account-status-mark" aria-hidden="true">{space.title.slice(0, 1)}</span>}</div>
      <div className="space-card-copy"><span className={`space-card-kind account-status account-status-${space.status}`}>
        {space.status === "ready" && space.scene ? (space.scene.public ? "Public" : "Private") : statusLabels[space.status]}{!space.hosted && space.status !== "unpaid" ? " · Offline" : ""}</span>
        <h2>{space.title}</h2></div>
    </a>
  </article>;
}

export default function AccountDashboard({ account, spaces, price, notice }:
  { account: AccountView; spaces: SpaceView[]; price?: PriceSummary; notice?: string }) {
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
  return <main className="space-library admin-library account-page"><div className="library-shell">
    <AccountHeader title="Your spaces" />
    <div className="admin-feedback" aria-live="polite">{message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}</div>
    {!account.emailVerified && <section className="account-notice"><p>Confirm your email address to add spaces. We sent a link to {account.email}.</p>
      <button type="button" onClick={resend}>Send a new link</button></section>}
    <BillingNotice account={account} spaces={spaces} price={price} />
    <form className="account-new" onSubmit={create}>
      <label htmlFor="space-title">New space</label>
      <div><input id="space-title" name="title" required maxLength={200} placeholder="Title, e.g. Riverside studio" disabled={!account.emailVerified} />
        <button type="submit" disabled={busy || !account.emailVerified}>{busy ? "Adding…" : account.billing && !active ? "Add and pay" : "Add space"}</button></div>
      {account.billing && price && <p className="admin-help">{active ? `Adds ${formatPrice(price).replace(" per space", "")}, prorated this period.` : `Checkout opens next. ${formatPrice(price)}; delete a space any time.`}</p>}
    </form>
    {spaces.length ? <section className="space-grid" aria-label="Your spaces">{spaces.map(space => <SpaceCard key={space.id} space={space} />)}</section>
      : <p className="library-empty">No spaces yet. Add one, upload your capture, and we will host it.</p>}
    <footer className="library-footer account-footer"><span>{account.email}</span></footer>
  </div></main>;
}
