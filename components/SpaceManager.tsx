"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { accountRequest } from "./AccountAuth";
import { accountNav, legalLinks, spaceStatus } from "./AccountDashboard";
import SiteHeader from "./site/SiteHeader";
import { SectionHeader, SiteFooter, StatusMark } from "./site/Chrome";
import UploadModal, { batchActive, useUploadBatches } from "./UploadModal";
import { getJson } from "./uploads";
import { formatBytes } from "@/lib/bytes";
import type { AccountView, SpaceView } from "@/lib/server/customer-spaces";

const describe: Record<string, string> = {
  unpaid: "Complete payment to start uploading.",
  draft: "Add your capture files and processing starts on its own once they are uploaded.",
  queued: "Submitted. An agent will start on your files shortly, and this page updates as it works.",
  processing: "An agent is processing your files. This page updates as it works, and we will email you when the space is ready.",
  ready: "Your space is hosted.",
  failed: "Processing could not finish. Add or replace files, then submit again."
};

export default function SpaceManager({ space: initial, account, brand }: { space: SpaceView; account: AccountView; brand: string }) {
  const [space, setSpace] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [modal, setModal] = useState(false);
  const [batchKey, setBatchKey] = useState<string | null>(null);
  const notes = useRef<HTMLTextAreaElement>(null);
  const editable = ["draft", "failed", "ready"].includes(space.status) && space.hosted;
  const complete = space.uploads.filter(upload => upload.status === "complete");

  const refresh = useCallback(async () => {
    const result = await getJson(`/api/account/spaces/${space.id}`).catch(() => undefined);
    if (result?.space) setSpace(result.space);
    return result?.space as SpaceView | undefined;
  }, [space.id]);
  const uploads = useUploadBatches(refresh);
  const batch = uploads.batches.find(item => item.key === batchKey);
  const uploading = uploads.batches.some(item => batchActive(item));

  const waiting = space.status === "queued" || space.status === "processing";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  const openUploads = useCallback(() => {
    if (!editable) return;
    setBatchKey(key => uploads.batches.some(item => item.key === key && batchActive(item)) ? key : null);
    setModal(true);
  }, [editable, uploads.batches]);

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
    if (!window.confirm(`Delete ${space.title}? It goes offline immediately, billing for it stops, and its uploaded files are deleted. This cannot be undone.`)) return;
    setBusy(true); setError("");
    try { await accountRequest(`/api/account/spaces/${space.id}`, undefined, "DELETE"); window.location.assign("/account"); }
    catch (failure) { setError((failure as Error).message); setBusy(false); }
  }

  const steps = [...(account.billing ? ["Payment"] : []), "Upload", "Processing", "Hosted"];
  const reached = space.status === "unpaid" ? "Payment" : ["draft", "failed"].includes(space.status) ? "Upload"
    : ["queued", "processing"].includes(space.status) ? "Processing" : "Hosted";
  const current = steps.indexOf(reached);
  const detail = space.hosted || space.status === "unpaid" ? describe[space.status] : "This space is offline because billing ended.";
  const status = spaceStatus(space);

  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={accountNav(account, "space")} account={account.email} signOut="account" />
    <main className="site-main">
      <a className="site-back" href="/account">← Your spaces</a>
      <div className="site-title">
        <div><h1>{space.title}</h1></div>
        <StatusMark status={status} label={status === "offline" ? "Offline" : undefined} />
      </div>
      <ol className="site-steps" aria-label="Progress">{steps.map((step, index) => <li key={step}
        className={index < current || (index === current && space.status === "ready") ? "done" : index === current ? "current" : ""}
        aria-current={index === current ? "step" : undefined}>{step}</li>)}</ol>
      <div className="site-feedback" aria-live="polite">
        {message && <p className="site-note" role="status">{message}</p>}
        {error && <p className="site-alert" role="alert">{error}</p>}
      </div>

      <div className="site-space">
        <div className="site-space-main">
          {space.scene && <section className="site-block" aria-labelledby="scene-heading">
            <SectionHeader title={<span id="scene-heading">Space</span>} />
            <a className="site-plate" href={space.scene.path} target="_blank" rel="noreferrer">
              <img src={space.scene.thumbnail} alt="" width={960} height={640} />
              <span className="site-plate-caption">Open space<span aria-hidden="true">↗</span></span>
            </a>
          </section>}

          <section className="site-block" aria-labelledby="files-heading">
            <SectionHeader title={<span id="files-heading">Files</span>}>{space.uploads.length > 0 && <span className="site-count">{space.uploads.length}</span>}</SectionHeader>
            {editable && <div className="space-files-add">
              <button type="button" className="site-button" onClick={openUploads}>{uploading ? "Show the upload" : "Add files"}<span aria-hidden="true">+</span></button>
              <p className="site-hint">Or drop files or a folder anywhere on this page. Up to {formatBytes(account.maxSpaceBytes)} per space.</p>
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
            </form>}
          </section>
        </div>

        <aside className="site-space-aside" aria-label="Details">
          <div className="site-aside-block">
            <h3>Status</h3>
            <p>{detail}</p>
            {waiting && space.job?.progress && <p className="site-progress" aria-live="polite"><span>Latest step</span>{space.job.progress}</p>}
            {space.message && !waiting && <blockquote className="site-quote">{space.message}</blockquote>}
            {space.status === "unpaid" && <a className="site-button site-button-accent site-button-block" href="/account/plan">Complete payment<span aria-hidden="true">→</span></a>}
          </div>
          {space.scene && <div className="site-aside-block">
            <h3>Sharing</h3>
            <div className="site-segmented" role="radiogroup" aria-label="Visibility">
              {(["private", "public"] as const).map(value => <button key={value} type="button" role="radio" aria-checked={(space.scene!.public ? "public" : "private") === value}
                disabled={busy || !space.hosted} onClick={() => { if ((space.scene!.public ? "public" : "private") !== value) void patch({ public: value === "public" }, value === "public" ? "Anyone with the link can now open this space." : "Only you can open this space now."); }}>
                {value === "public" ? "Public" : "Private"}</button>)}
            </div>
            <p className="site-hint">{space.scene.public ? "Anyone with the link can open it." : "Only you can open it while it is private."}</p>
            <a className="site-button site-button-secondary site-button-block" href={`/account/spaces/${space.id}/edit`}>Edit title and start view</a>
            <a className="site-button site-button-secondary site-button-block" href={`/account/tours/new?scene=${space.scene.sceneId}`}>Make a tour or scavenger hunt</a>
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
      onBatch={key => setBatchKey(key)} existing={space} maxBytes={account.maxSpaceBytes} />
  </div></div>;
}
