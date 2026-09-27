"use client";

import { useCallback, useEffect, useState } from "react";
import { accountRequest } from "./AccountAuth";
import SiteHeader from "./site/SiteHeader";
import { ConstructionDrawing, SiteFooter, StatusMark } from "./site/Chrome";
import UploadModal, { awaitingPaymentKey, batchActive, useUploadBatches, type Batch } from "./UploadModal";
import { cheaperPlan, currentPlan, hostingActive, periodTotal } from "./PlanPicker";
import { getJson } from "./uploads";
import { formatBytes } from "@/lib/bytes";
import type { AccountView, SpaceView } from "@/lib/server/customer-spaces";
import type { Plan } from "@/lib/server/billing";
import { formatMoney, formatPeriod } from "@/lib/price";

export const legalLinks = [{ href: "/terms", label: "Terms" }, { href: "/privacy", label: "Privacy" }];

function formatDate(seconds: number | null) {
  return seconds ? new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
}

function shortDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Stripe's billing portal: payment methods, invoices and cancellation. */
export async function openPortal() {
  const { url } = await accountRequest("/api/account/billing/portal");
  window.location.assign(url);
}

/** The account's pages; the plan page is listed once there is billing to manage. */
export function accountNav(account: AccountView, current: "spaces" | "plan" | "space") {
  return [{ href: "/account", label: "Your spaces", current: current === "spaces" },
    ...(account.billing && (account.subscription || current === "plan") ? [{ href: "/account/plan", label: "Plan", current: current === "plan" }] : [])];
}

/** The status a space shows on its card. */
export function spaceStatus(space: SpaceView) {
  if (!space.hosted && space.status !== "unpaid") return "offline";
  if (space.status === "ready" && space.scene) return space.scene.public ? "public" : "private";
  return space.status;
}

/**
 * The plan, the spaces it holds, its price and renewal date for subscribers, and a call to action
 * when billing needs attention. Choosing a plan and paying happen on the plan page.
 */
function BillingBar({ account, spaces, plans }: { account: AccountView; spaces: SpaceView[]; plans: Plan[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const subscription = account.subscription;
  const active = hostingActive(account);
  const unpaid = spaces.some(space => space.status === "unpaid");
  async function portal() {
    setBusy(true); setError("");
    try { await openPortal(); } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  let alert = "", action: ["plan" | "portal", string] | undefined;
  if (subscription && ["unpaid", "incomplete", "paused"].includes(subscription.status)) {
    alert = "Hosting is paused until a payment goes through. Update your payment method to bring your spaces back online.";
    action = ["portal", "Update payment method"];
  } else if (!active && spaces.length && (unpaid || subscription)) {
    alert = subscription ? "Hosting is paused because billing ended. Restart billing to bring your spaces back online." : "Complete payment to start uploading.";
    action = ["plan", subscription ? "Restart billing" : "Complete payment"];
  } else if (subscription?.status === "past_due") {
    alert = "Your last payment did not go through. Update your payment method to keep your spaces online.";
    action = ["portal", "Update payment method"];
  }
  if (!account.billing || (!alert && !(active && subscription))) return null;
  const plan = currentPlan(plans, subscription);
  const hosted = spaces.filter(space => space.status !== "unpaid").length;
  const covers = subscription?.plan?.spaces ?? null;
  const total = subscription && periodTotal(subscription);
  const better = active && covers === null ? cheaperPlan(plans, hosted) : undefined;
  return <>
    {alert && <div className="site-callout site-callout-action" role="status">
      <p>{alert}</p>
      {action && (action[0] === "plan" ? <a className="site-button site-button-accent" href="/account/plan">{action[1]}</a>
        : <button type="button" className="site-button" disabled={busy} onClick={portal}>{busy ? "Opening…" : action[1]}</button>)}
    </div>}
    {!alert && active && subscription && <div className="spaces-billing">
      <p><strong>{plan?.name ?? (covers === null ? "Pay as you go" : "Your plan")}</strong>
        <span>{covers === null ? `${hosted} ${hosted === 1 ? "space" : "spaces"}` : `${hosted} of ${covers} spaces`}</span>
        {total && <span>{total}</span>}
        {subscription.periodEnd ? <span>{subscription.cancelAtPeriodEnd ? "Ends" : "Renews"} {formatDate(subscription.periodEnd)}</span> : null}
        {better && <a className="spaces-billing-offer" href="/account/plan">{better.name} covers up to {better.spaces} spaces for {formatMoney(better.amount, better.currency)} {formatPeriod(better.interval, better.intervalCount)}</a>}</p>
      <span className="spaces-billing-actions">
        <a className="site-link" href="/account/plan">Change plan</a>
        <button type="button" className="site-link" disabled={busy} onClick={portal}>{busy ? "Opening…" : "Billing and invoices"}</button>
      </span>
    </div>}
    {error && <p className="site-alert" role="alert">{error}</p>}
  </>;
}

/** The drawing from the empty state, with a scan line passing over it while an agent works. */
function Working() {
  return <span className="space-art space-art-working" aria-hidden="true"><ConstructionDrawing /><i /></span>;
}

function batchLine(batch: Batch) {
  const count = batch.transfers.length;
  const total = batch.transfers.reduce((sum, item) => sum + item.size, 0);
  const sent = batch.transfers.reduce((sum, item) => sum + Math.min(item.sent, item.size), 0);
  const percent = total ? Math.floor(sent / total * 100) : 0;
  if (batch.phase === "creating") return { tag: "Setting up", line: `${count} ${count === 1 ? "file" : "files"}, ${formatBytes(total)}`, percent };
  if (batch.phase === "payment") return { tag: "Waiting for payment", line: "Finish checkout and the upload starts", percent: 0 };
  if (batch.phase === "countdown") return { tag: "Uploaded", line: `Processing starts in ${batch.countdown} s`, percent: 100 };
  if (batch.phase === "held") return { tag: "Uploaded", line: "Ready to process", percent: 100 };
  if (batch.phase === "submitting") return { tag: "Uploaded", line: "Starting processing", percent: 100 };
  const failed = batch.transfers.some(item => item.state === "failed");
  return { tag: failed ? "Upload stopped" : "Uploading", line: `${formatBytes(sent)} of ${formatBytes(total)}`, percent };
}

function SpaceCard({ space, batch, onOpenBatch }: { space: SpaceView; batch?: Batch; onOpenBatch: (key: string) => void }) {
  const manage = `/account/spaces/${space.id}`;
  const status = spaceStatus(space);
  const files = space.uploads.filter(upload => upload.status === "complete");
  const bytes = files.reduce((sum, upload) => sum + upload.size, 0);

  if (batch && batchActive(batch)) {
    const { tag, line, percent } = batchLine(batch);
    return <article className="space-card space-card-uploading">
      <button type="button" className="space-card-media" onClick={() => onOpenBatch(batch.key)} aria-label={`Show the upload for ${space.title}`}>
        <span className="space-art space-art-upload" aria-hidden="true"><ConstructionDrawing /><b>{percent}%</b></span>
        <span className="space-card-tag"><StatusMark status="processing" label={tag} /></span>
        <span className="space-card-meter" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
      </button>
      <div className="space-card-body">
        <h3><a href={manage}>{batch.title}</a></h3>
        <p>{line}</p>
      </div>
    </article>;
  }

  const working = space.status === "queued" || space.status === "processing";
  const ready = space.status === "ready" && space.scene && space.hosted;
  let line = `Added ${shortDate(space.created)}`;
  if (space.status === "unpaid") line = "Complete payment to start uploading";
  else if (space.status === "draft") line = files.length ? `${files.length} ${files.length === 1 ? "file" : "files"}, ${formatBytes(bytes)}` : "No files yet";
  else if (space.status === "queued") line = "Waiting for an agent";
  else if (space.status === "processing") line = space.job?.progress ?? "An agent is working on it";
  else if (space.status === "failed") line = space.message?.split("\n")[0] ?? "Processing could not finish";
  else if (!space.hosted) line = "Offline until billing restarts";
  const tag = status === "draft" ? "Add files" : status === "queued" ? "In the queue" : undefined;

  const media = <>
    {ready ? <img src={space.scene!.thumbnail} alt="" loading="lazy" width={960} height={640} />
      : working ? <Working />
      : <span className="space-art" aria-hidden="true"><ConstructionDrawing /></span>}
    <span className="space-card-tag"><StatusMark status={status} label={tag} /></span>
    {ready && <span className="space-card-open">Open space<span aria-hidden="true">↗</span></span>}
  </>;

  return <article className={`space-card space-card-${space.status}`}>
    {ready ? <a className="space-card-media" href={space.scene!.path} target="_blank" rel="noreferrer" aria-label={`Open ${space.title}`}>{media}</a>
      : <a className="space-card-media" href={manage} aria-label={`Manage ${space.title}`} tabIndex={-1}>{media}</a>}
    <div className="space-card-body">
      <h3><a href={manage}>{space.title}</a></h3>
      <p className={working ? "space-card-step" : undefined} aria-live={working ? "polite" : undefined}>{line}</p>
    </div>
  </article>;
}

export default function AccountDashboard({ account: initialAccount, spaces: initial, plans, notice, fromCheckout, brand }:
  { account: AccountView; spaces: SpaceView[]; plans: Plan[]; notice?: string; fromCheckout?: boolean; brand: string }) {
  const [spaces, setSpaces] = useState(initial);
  const [account, setAccount] = useState(initialAccount);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(notice ?? "");
  const [modal, setModal] = useState(false);
  const [batchKey, setBatchKey] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const result = await getJson("/api/account/spaces").catch(() => undefined);
    if (result?.spaces) setSpaces(result.spaces);
    if (result?.account) setAccount(result.account);
  }, []);
  const uploads = useUploadBatches(refresh);
  const blocked = !account.emailVerified;

  async function resend() {
    setError(""); setMessage("");
    try { await accountRequest("/api/account/verify/resend"); setMessage(`We sent a new link to ${account.email}.`); }
    catch (failure) { setError((failure as Error).message); }
  }

  // Checkout opened from the upload sheet lands here in a new tab; the upload goes on in the first one.
  useEffect(() => {
    if (!fromCheckout) return;
    try {
      const waiting = JSON.parse(localStorage.getItem(awaitingPaymentKey) ?? "null") as { at: number } | null;
      if (waiting && Date.now() - waiting.at < 30 * 60 * 1000) setMessage("Payment received. Your files are uploading in the tab where you added the space, so you can close this one.");
    } catch { /* The usual notice stays. */ }
  }, [fromCheckout]);

  // Cards follow the agent's progress.
  const working = spaces.some(space => space.status === "queued" || space.status === "processing");
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [working, refresh]);

  const current = uploads.batches.find(batch => batch.key === batchKey);
  // Every new sheet starts a new space; batches already running carry on in their cards.
  const openFresh = useCallback(() => {
    if (blocked) return;
    setBatchKey(null);
    setModal(true);
  }, [blocked]);

  // Files dragged anywhere over the page open the sheet to receive them.
  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => { if (hasFiles(event) && !modal) openFresh(); };
    const over = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault(); };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", over);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("drop", over); };
  }, [modal, openFresh]);

  const active = hostingActive(account);
  const plan = currentPlan(plans, account.subscription);
  const perSpace = plans.find(item => item.spaces === null);
  const covers = active ? account.subscription?.plan?.spaces ?? null : null;
  const priceHint = !account.billing ? undefined
    : !active ? perSpace && `You start on pay as you go at ${formatMoney(perSpace.amount, perSpace.currency)} ${formatPeriod(perSpace.interval, perSpace.intervalCount)} for each space, and you can choose a plan before paying.`
    : covers !== null ? `${plan?.name ?? "Your plan"} covers ${covers} spaces and you have ${account.spaceCount}.`
    : account.subscription?.plan?.amount ? `Each space adds ${formatMoney(account.subscription.plan.amount, account.subscription.plan.currency)} ${formatPeriod(account.subscription.plan.interval, account.subscription.plan.intervalCount)}, prorated for this period.`
    : undefined;
  const bySpace = new Map(uploads.batches.filter(batch => batch.spaceId).map(batch => [batch.spaceId!, batch]));
  // A space that is still being created has no card yet.
  const pending = uploads.batches.filter(batch => !batch.spaceId && batchActive(batch));

  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={accountNav(account, "spaces")} account={account.email} signOut="account" />
    <main className="site-main">
      <div className="spaces-head">
        <div>
          <h1>Your spaces</h1>
          <p>Drop a capture anywhere on this page and it becomes a space you can share.</p>
        </div>
        <button type="button" className="site-button site-button-accent spaces-add-button" onClick={openFresh} disabled={blocked}>
          <span aria-hidden="true" className="spaces-plus" />Add a space
        </button>
      </div>
      <div className="site-feedback" aria-live="polite">
        {message && <p className="site-note" role="status">{message}</p>}
        {error && <p className="site-alert" role="alert">{error}</p>}
      </div>
      {blocked && <div className="site-callout site-callout-action">
        <p>Confirm your email address to add spaces. We sent a link to <strong>{account.email}</strong>.</p>
        <button type="button" className="site-button site-button-secondary" onClick={resend}>Send a new link</button>
      </div>}
      <BillingBar account={account} spaces={spaces} plans={plans} />

      {spaces.length || pending.length ? <section aria-label="Spaces" className="spaces-grid">
        <button type="button" className="space-add" onClick={openFresh} disabled={blocked}>
          <span className="space-add-art" aria-hidden="true"><span className="spaces-plus" /></span>
          <span className="space-add-title">Add a space</span>
          <span className="space-add-hint">Drop files or a folder</span>
        </button>
        {pending.map(batch => <article key={batch.key} className="space-card space-card-uploading">
          <button type="button" className="space-card-media" onClick={() => { setBatchKey(batch.key); setModal(true); }}>
            <span className="space-art space-art-upload" aria-hidden="true"><ConstructionDrawing /></span>
            <span className="space-card-tag"><StatusMark status="processing" label={batch.phase === "full" ? "Plan full" : "Setting up"} /></span>
          </button>
          <div className="space-card-body"><h3>{batch.title}</h3><p>{batch.phase === "full" ? "Change plans to add it" : "Creating the space"}</p></div>
        </article>)}
        {spaces.map(space => <SpaceCard key={space.id} space={space} batch={bySpace.get(space.id)} onOpenBatch={key => { setBatchKey(key); setModal(true); }} />)}
      </section>
      : <button type="button" className="spaces-empty" onClick={openFresh} disabled={blocked}>
        <ConstructionDrawing />
        <span className="spaces-empty-copy">
          <strong>Add your first space</strong>
          <span>Drop capture files or a whole folder anywhere on this page. The title comes from the file names, and an agent turns the files into a space you can share.</span>
          <span className="site-button" aria-hidden="true">Add a space</span>
        </span>
      </button>}
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
    <UploadModal open={modal} onClose={() => setModal(false)} uploads={uploads} batchKey={current ? batchKey : null}
      onBatch={key => setBatchKey(key)} maxBytes={account.maxSpaceBytes} priceHint={priceHint}
      billing={account.billing ? { plans, current: active ? plan?.id ?? null : null, spaces: account.spaceCount, brand, sourceUrl: account.sourceUrl } : undefined} />
  </div></div>;
}
