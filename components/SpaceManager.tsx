"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { accountRequest } from "./AccountAuth";
import { googleEvent, track } from "./Analytics";
import { accountNav, legalLinks, spaceStatus } from "./AccountDashboard";
import SiteHeader from "./site/SiteHeader";
import { SectionHeader, SiteFooter, StatusMark } from "./site/Chrome";
import UploadModal, { batchActive, useUploadBatches } from "./UploadModal";
import { getJson } from "./uploads";
import { formatBytes } from "@/lib/bytes";
import { formatMoney, formatPeriod } from "@/lib/price";
import type { Plan } from "@/lib/server/billing";
import type { AccountView, SpaceView } from "@/lib/server/customer-spaces";

const describe: Record<string, string> = {
  unpaid: "Complete payment to start uploading.",
  draft: "Add your capture files and processing starts on its own once they are uploaded.",
  queued: "Submitted. An agent will start on your files shortly, and this page updates as it works.",
  processing: "An agent is processing your files. This page updates as it works, and we will email you when the space is ready.",
  ready: "Your space is hosted.",
  failed: "Processing could not finish. Add or replace files, then submit again."
};

/** The same, for a space made from a Matterport link. */
const describeLink: Record<string, string> = {
  ...describe,
  unpaid: "Complete payment to bring over your Matterport space.",
  draft: "Ready to bring over your Matterport space. Start processing below.",
  queued: "Submitted. An agent will start bringing over your Matterport space shortly, and this page updates as it works.",
  processing: "An agent is bringing over your Matterport space. This page updates as it works, and we will email you when the space is ready.",
  failed: "Processing could not finish. Check that the Matterport space is public or unlisted, then submit again."
};

/** A date without a time zone surprise: the preview's last day, as the server sees it. */
export const previewDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : "";
const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

/**
 * The result screen of a free preview: the space is ready and private, and hosting publishes it or keeps it.
 * One button opens Checkout on pay as you go and returns here; the plans are one link away.
 */
export function PublishGate({ space, plans, surface = "space" }: { space: SpaceView; plans: Plan[]; surface?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const preview = space.preview!;
  const perSpace = plans.find(plan => plan.spaces === null);
  const price = perSpace && `${formatMoney(perSpace.amount, perSpace.currency)} ${formatPeriod(perSpace.interval, perSpace.intervalCount)}`;
  useEffect(() => { track("publish_gate_shown", { surface, left: preview.daysLeft ?? 0 }); }, [surface, preview.daysLeft]);
  async function host() {
    setBusy(true); setError("");
    track("checkout_opened", { plan: perSpace?.id ?? "", from: "preview" });
    try {
      const result = await accountRequest("/api/account/billing/checkout", { space: space.id, ...(perSpace ? { plan: perSpace.id } : {}) });
      // Without a link, a payment made earlier was just applied.
      window.location.assign(result.url ?? `/account/spaces/${space.id}`);
    } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  return <section className="site-callout publish-gate" aria-labelledby="publish-gate-title">
    <h2 id="publish-gate-title">Your preview is ready</h2>
    <p>Only you can open it, until {previewDate(preview.until)} ({days(preview.daysLeft ?? 0)} left). Start hosting to make it public with a link you can share and an embed
      for your own site, or to keep it after that date. Hosting also lets you build tours and scavenger hunts on it. It is the same space and the same link either way.</p>
    {error && <p className="site-alert" role="alert">{error}</p>}
    <div className="site-actions">
      <button type="button" className="site-button site-button-accent" disabled={busy} onClick={() => void host()}>
        {busy ? "Opening payment…" : price ? `Host it for ${price}` : "Start hosting"}<span aria-hidden="true">→</span></button>
      <a className="site-link" href={`/account/plan?space=${space.id}`}>See all plans</a>
    </div>
    {price && <p className="site-hint">Pay as you go is billed for each space and you can cancel any time. You pay on Stripe's secure checkout page and come back here.</p>}
  </section>;
}

export default function SpaceManager({ space: initial, account, brand, plans = [], notice, fromCheckout = false }: { space: SpaceView; account: AccountView; brand: string; plans?: Plan[];
  notice?: string; fromCheckout?: boolean }) {
  const [space, setSpace] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(notice ?? "");
  const [modal, setModal] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [batchKey, setBatchKey] = useState<string | null>(null);
  const notes = useRef<HTMLTextAreaElement>(null);
  // A free preview is private to its owner, and usable until its window ends.
  const preview = space.hosted ? null : space.preview;
  const previewing = Boolean(preview?.open);
  const lapsed = Boolean(preview?.expired);
  const usable = space.hosted || previewing;
  const editable = ["draft", "failed", "ready"].includes(space.status) && usable;
  const complete = space.uploads.filter(upload => upload.status === "complete");

  const refresh = useCallback(async () => {
    const result = await getJson(`/api/account/spaces/${space.id}`).catch(() => undefined);
    if (result?.space) setSpace(result.space);
    return result?.space as SpaceView | undefined;
  }, [space.id]);
  const uploads = useUploadBatches(refresh);
  const batch = uploads.batches.find(item => item.key === batchKey);
  const uploading = uploads.batches.some(item => batchActive(item));

  // Paying from a preview returns here. Google Analytics counts the payment once per Checkout session; the server records it for the site's own numbers.
  useEffect(() => {
    const plan = account.subscription?.plan;
    if (fromCheckout && initial.hosted && plan) googleEvent("purchase", { transaction_id: new URLSearchParams(window.location.search).get("checkout") ?? "",
      currency: plan.currency.toUpperCase(), value: ((plan.amount ?? 0) * (plan.spaces ? 1 : account.subscription?.quantity ?? 1)) / 100 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, on arrival from Checkout

  const waiting = space.status === "queued" || space.status === "processing";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  const openUploads = useCallback(() => {
    if (!editable || space.source) return;
    setBatchKey(key => uploads.batches.some(item => item.key === key && batchActive(item)) ? key : null);
    setModal(true);
  }, [editable, space.source, uploads.batches]);

  // Files dragged anywhere over the page open the sheet to receive them.
  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => { if (hasFiles(event) && !modal) openUploads(); };
    const over = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault(); };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", over);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("drop", over); };
  }, [modal, openUploads]);

  async function remove(id: string, name: string) {
    if (!window.confirm(`Remove ${name}?`)) return;
    setError("");
    try { await accountRequest(`/api/account/uploads/${id}`, undefined, "DELETE"); await refresh(); }
    catch (failure) { setError((failure as Error).message); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await accountRequest(`/api/account/spaces/${space.id}/submit`, { notes: notes.current?.value ?? "" });
      setSpace(result.space);
      setMessage("Processing started.");
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  async function patch(body: object, done: string) {
    setBusy(true); setError(""); setMessage("");
    try { const result = await accountRequest(`/api/account/spaces/${space.id}`, body, "PATCH"); setSpace(result.space); setMessage(done); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  async function destroy() {
    const spent = space.previewed && !space.hosted && space.job ? " Your free preview is used up, so deleting it does not give you another." : "";
    if (!window.confirm(`Delete ${space.title}? It goes offline immediately, billing for it stops, and its uploaded files are deleted. This cannot be undone.${spent}`)) return;
    setBusy(true); setError("");
    try { await accountRequest(`/api/account/spaces/${space.id}`, undefined, "DELETE"); window.location.assign("/account"); }
    catch (failure) { setError((failure as Error).message); setBusy(false); }
  }

  // A space that started as the free preview has no payment step before its files; payment comes after the preview.
  const link = space.source;
  const added = link ? "Link" : "Upload";
  const steps = [...(account.billing && !space.previewed ? ["Payment"] : []), added, "Processing", ...(space.previewed ? ["Preview"] : []), "Hosted"];
  const reached = space.status === "unpaid" ? "Payment" : ["draft", "failed"].includes(space.status) ? added
    : ["queued", "processing"].includes(space.status) ? "Processing" : space.previewed && !space.hosted ? "Preview" : "Hosted";
  const current = steps.indexOf(reached);
  const detail = previewing && space.status === "ready" ? `Your free preview is private. Only you can open it, until ${previewDate(preview!.until)}.`
    : previewing && space.status === "draft" ? link ? "This is your free preview. Start processing below to bring over your Matterport space. The result stays private to you."
      : "This is your free preview. Add your capture files and processing starts on its own once they are uploaded. The result stays private to you."
    : lapsed ? `Your free preview ended${preview!.until ? ` on ${previewDate(preview!.until)}` : ""}, so this space is offline. Start hosting to bring it back.`
    // A preview being processed is not offline: it reads like any space at that step.
    : space.hosted || space.status === "unpaid" || previewing ? (link ? describeLink : describe)[space.status] : "This space is offline because billing ended.";
  const status = spaceStatus(space);
  const gate = previewing && space.status === "ready" && space.scene ? <PublishGate space={space} plans={plans} /> : null;
  // A free preview is kept by hosting it, so it downloads once hosted.
  const downloadable = space.hosted || !space.previewed;
  async function downloadEverything() {
    const url = `/api/admin/scenes/${space.scene!.sceneId}/download`;
    setDownloading(true); setError(""); setMessage("");
    try {
      // Asked first, so a refusal shows here instead of as a failed download.
      const check = await fetch(url, { method: "HEAD", credentials: "same-origin", cache: "no-store" });
      if (!check.ok) throw new Error(check.status === 402 ? "Start hosting this space to download everything."
        : check.status === 401 ? "Sign in again to download this space."
        : check.status === 429 ? "Other downloads are still running. Try again when they finish."
        : "This space's files are unavailable right now. Try again in a few minutes.");
      const bytes = Number(check.headers.get("content-length"));
      window.location.assign(url);
      setMessage(bytes > 0 ? `Your download has started. It is ${formatBytes(bytes)}.` : "Your download has started.");
    } catch (failure) { setError((failure as Error).message); }
    finally { setDownloading(false); }
  }
  async function startPreview() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await accountRequest(`/api/account/spaces/${space.id}/preview`);
      setSpace(result.space);
      setMessage("Your free preview has started. Add your capture files below.");
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={accountNav(account, "space")} account={account.email} signOut="account" />
    <main className="site-main">
      <a className="site-back" href="/account">← Your spaces</a>
      <div className="site-title">
        <div><h1>{space.title}</h1></div>
        <StatusMark status={status} label={status === "offline" ? "Offline" : previewing && status === "private" ? "Private preview" : link && status === "draft" ? "Ready to process" : undefined} />
      </div>
      <ol className="site-steps" aria-label="Progress">{steps.map((step, index) => <li key={step}
        className={index < current || (index === current && space.status === "ready") ? "done" : index === current ? "current" : ""}
        aria-current={index === current ? "step" : undefined}>{step}</li>)}</ol>
      <div className="site-feedback" aria-live="polite">
        {message && <p className="site-note" role="status">{message}</p>}
        {error && <p className="site-alert" role="alert">{error}</p>}
      </div>

      {gate}
      {lapsed && space.status !== "unpaid" && <div className="site-callout site-callout-action" role="status">
        <p>{detail}</p>
        <a className="site-button site-button-accent" href={`/account/plan?space=${space.id}`}>Start hosting<span aria-hidden="true">→</span></a>
      </div>}

      <div className="site-space">
        <div className="site-space-main">
          {space.scene && (usable || !space.previewed) && <section className="site-block" aria-labelledby="scene-heading">
            <SectionHeader title={<span id="scene-heading">{previewing ? "Private preview" : "Space"}</span>} />
            <a className="site-plate" href={space.scene.path} target="_blank" rel="noreferrer" onClick={() => { if (previewing) track("preview_opened", { from: "space_page" }); }}>
              <img src={space.scene.thumbnail} alt="" width={960} height={640} />
              <span className="site-plate-caption">{previewing ? "Open your preview" : "Open space"}<span aria-hidden="true">↗</span></span>
            </a>
          </section>}

          {link ? <section className="site-block" aria-labelledby="files-heading">
            <SectionHeader title={<span id="files-heading">Matterport space</span>} />
            <p className="space-link"><a href={link.url} target="_blank" rel="noreferrer">{link.url}<span aria-hidden="true">↗</span></a></p>
            {editable && <form className="site-form site-submit" onSubmit={submit}>
              <div className="site-field"><label htmlFor="notes">Notes for processing <span className="site-optional">Optional</span></label>
                <textarea className="site-input" ref={notes} id="notes" name="notes" maxLength={2000} rows={3} defaultValue={space.notes ?? ""} placeholder="Anything we should know about the space" /></div>
              <div><button type="submit" className="site-button" disabled={busy}>{space.status === "ready" ? "Bring it over again" : "Start processing"}<span aria-hidden="true">→</span></button></div>
              {previewing && <p className="site-hint">A free preview can be processed {preview!.runsLeft} more {preview!.runsLeft === 1 ? "time" : "times"}. Hosting lifts that.</p>}
            </form>}
          </section>
          : <section className="site-block" aria-labelledby="files-heading">
            <SectionHeader title={<span id="files-heading">Files</span>}>{space.uploads.length > 0 && <span className="site-count">{space.uploads.length}</span>}</SectionHeader>
            {editable && <div className="space-files-add">
              <button type="button" className="site-button" onClick={openUploads}>{uploading ? "Show the upload" : "Add files"}<span aria-hidden="true">+</span></button>
              <p className="site-hint">Or drop files or a folder anywhere on this page. {previewing
                ? `A free preview holds up to ${preview!.files} files and ${formatBytes(preview!.bytes)}.` : `Up to ${formatBytes(account.maxSpaceBytes)} per space.`}</p>
            </div>}
            {space.uploads.length > 0 ? <ul className="site-files" aria-label="Uploaded files">{space.uploads.map(upload => <li key={upload.id}>
              <span className="site-file-name">{upload.name}</span>
              <span className="site-file-meta">{formatBytes(upload.size)}{upload.status === "uploading" ? ", incomplete" : ""}</span>
              {(editable || upload.status === "uploading") && <button type="button" className="site-link" onClick={() => remove(upload.id, upload.name)}>Remove</button>}
            </li>)}</ul> : !editable && <p className="site-hint">No files.</p>}
            {editable && complete.length > 0 && !uploading && <form className="site-form site-submit" onSubmit={submit}>
              <div className="site-field"><label htmlFor="notes">Notes for processing <span className="site-optional">Optional</span></label>
                <textarea className="site-input" ref={notes} id="notes" name="notes" maxLength={2000} rows={3} defaultValue={space.notes ?? ""} placeholder="Capture device, what the space is, anything we should know" /></div>
              <div><button type="submit" className="site-button" disabled={busy}>{space.status === "ready" ? "Reprocess with these files" : "Start processing"}<span aria-hidden="true">→</span></button></div>
              {previewing && <p className="site-hint">A free preview can be processed {preview!.runsLeft} more {preview!.runsLeft === 1 ? "time" : "times"}. Hosting lifts that.</p>}
            </form>}
          </section>}
        </div>

        <aside className="site-space-aside" aria-label="Details">
          <div className="site-aside-block">
            <h3>Status</h3>
            <p>{detail}</p>
            {waiting && space.job?.progress && <p className="site-progress" aria-live="polite"><span>Latest step</span>{space.job.progress}</p>}
            {space.message && !waiting && <blockquote className="site-quote">{space.message}</blockquote>}
            {space.status === "unpaid" && account.preview?.available && <button type="button" className="site-button site-button-accent site-button-block" disabled={busy}
              onClick={() => void startPreview()}>Try it free first<span aria-hidden="true">→</span></button>}
            {space.status === "unpaid" && <a className={`site-button site-button-block${account.preview?.available ? " site-button-secondary" : " site-button-accent"}`} href="/account/plan">Complete payment<span aria-hidden="true">→</span></a>}
            {space.status === "unpaid" && account.preview?.available && <p className="site-hint">A free preview lets you upload now. Up to {account.preview.maxFiles} files and {formatBytes(account.preview.maxBytes)}, private to you, and you pay only to publish it or keep it past {days(account.preview.days)}.</p>}
          </div>
          {space.scene && <div className="site-aside-block">
            <h3>Sharing</h3>
            <div className="site-segmented" role="radiogroup" aria-label="Visibility">
              {(["private", "public"] as const).map(value => <button key={value} type="button" role="radio" aria-checked={(space.scene!.public ? "public" : "private") === value}
                disabled={busy || !space.hosted} onClick={() => { if ((space.scene!.public ? "public" : "private") !== value) void patch({ public: value === "public" }, value === "public" ? "Anyone with the link can now open this space." : "Only you can open this space now."); }}>
                {value === "public" ? "Public" : "Private"}</button>)}
            </div>
            <p className="site-hint">{previewing ? "A free preview stays private. Public links and embeds come with hosting."
              : space.scene.public ? "Anyone with the link can open it." : "Only you can open it while it is private."}</p>
            {!previewing && <label className="site-check">
              <input type="checkbox" checked={space.scene.builders} disabled={busy || !space.hosted}
                onChange={event => void patch({ builders: event.target.checked }, event.target.checked
                  ? space.scene!.public ? "Anyone who opens this space can now build on it." : "Others can build on this space once it is public."
                  : "Only you can build on this space now. Tours others made on it are offline until you allow building again.")} />
              Allow others to build on this space
            </label>}
            {!previewing && <p className="site-hint">{space.scene.builders && !space.scene.public ? "This starts once the space is public. "
              : ""}People who open it can make their own guided tours and scavenger hunts on it, with their own effects, models and sound. Your space itself never changes.</p>}
            {(usable || !space.previewed) && <a className="site-button site-button-secondary site-button-block" href={`/account/spaces/${space.id}/edit`}>Edit title and start view</a>}
            {space.hosted && <a className="site-button site-button-secondary site-button-block" href={`/account/tours/new?scene=${space.scene.sceneId}`}>Make a tour or scavenger hunt</a>}
          </div>}
          {space.scene && <div className="site-aside-block">
            <h3>Keep a copy</h3>
            <p className="site-hint">Download everything in this space as one zip file. Its photos, mesh or splats come as they are stored, with its tours, tags and details
              and a README that says what each file is.</p>
            <button type="button" className="site-button site-button-secondary site-button-block" disabled={downloading || !downloadable}
              onClick={() => void downloadEverything()}>{downloading ? "Preparing…" : "Download everything"}<span aria-hidden="true">↓</span></button>
            {!downloadable && <p className="site-hint">Downloads come with hosting.</p>}
          </div>}
          <div className="site-aside-block">
            <h3>Settings</h3>
            {!space.scene && space.status !== "processing" && <form className="site-form" onSubmit={event => { event.preventDefault(); void patch({ title: new FormData(event.currentTarget).get("title") }, "Title saved."); }}>
              <div className="site-field"><label htmlFor="title">Title</label><input className="site-input" id="title" name="title" defaultValue={space.title} key={space.title} required maxLength={200} /></div>
              <div><button type="submit" className="site-button site-button-secondary" disabled={busy}>Save title</button></div>
            </form>}
            <button type="button" className="site-link site-danger" disabled={busy} onClick={destroy}>Delete this space</button>
          </div>
        </aside>
      </div>
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
    <UploadModal open={modal} onClose={() => { setModal(false); void refresh(); }} uploads={uploads} batchKey={batch ? batchKey : null}
      onBatch={key => setBatchKey(key)} existing={space} maxBytes={previewing ? preview!.bytes : account.maxSpaceBytes} />
  </div></div>;
}
