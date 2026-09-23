"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { accountRequest } from "./AccountAuth";
import { legalLinks, openBilling, spaceStatus } from "./AccountDashboard";
import SiteHeader from "./site/SiteHeader";
import { SectionHeader, SiteFooter, StatusMark } from "./site/Chrome";
import type { AccountView, SpaceView } from "@/lib/server/customer-spaces";

type Transfer = { key: string; name: string; size: number; sent: number; state: "uploading" | "retrying" | "done" | "failed"; error?: string };

const describe: Record<string, string> = {
  unpaid: "Complete payment to start uploading.",
  draft: "Upload your capture files, then submit them for processing.",
  queued: "Submitted. An agent will start on your files shortly; this page updates as it works.",
  processing: "An agent is processing your files. This page updates as it works, and we will email you when the space is ready.",
  ready: "Your space is hosted.",
  failed: "Processing could not finish. Add or replace files, then submit again."
};

export function formatBytes(bytes: number) {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Sends one chunk with the resumable protocol; resolves with the status and any persisted offset. */
function sendChunk(url: string, blob: Blob, start: number, total: number, progress: (bytes: number) => void) {
  return new Promise<{ status: number; offset?: number }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Range", `bytes ${start}-${start + blob.size - 1}/${total}`);
    request.upload.onprogress = event => progress(event.loaded);
    request.onerror = () => reject(new Error("Network error"));
    request.onload = () => {
      const range = request.getResponseHeader("Range")?.match(/^bytes=0-(\d+)$/);
      let offset = range ? Number(range[1]) + 1 : undefined;
      try { offset ??= JSON.parse(request.responseText).offset; } catch { /* Cloud Storage replies with object metadata. */ }
      resolve({ status: request.status, offset });
    };
    request.send(blob);
  });
}

async function getJson(url: string) {
  const response = await fetch(url, { method: "GET" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

async function uploadFile(spaceId: string, file: File, update: (patch: Partial<Transfer>) => void) {
  const { upload, url, chunkSize } = await accountRequest(`/api/account/spaces/${spaceId}/uploads`, { name: file.name, size: file.size, type: file.type });
  let offset = 0, failures = 0;
  while (offset < file.size) {
    const end = Math.min(offset + chunkSize, file.size);
    try {
      const result = await sendChunk(url, file.slice(offset, end), offset, file.size, bytes => update({ sent: offset + bytes }));
      if (result.status === 200 || result.status === 201) offset = file.size;
      else if (result.status === 308) offset = result.offset ?? (await getJson(`/api/account/uploads/${upload.id}`)).offset;
      else if (result.status >= 500 || result.status === 429 || result.status === 416) throw new Error(`HTTP ${result.status}`);
      else throw Object.assign(new Error("The upload was rejected. Remove the file and try again."), { final: true });
      failures = 0;
      update({ sent: offset, state: "uploading" });
    } catch (failure) {
      if ((failure as { final?: boolean }).final || ++failures > 8) throw failure;
      update({ state: "retrying" });
      await wait(Math.min(30000, 1000 * 2 ** failures));
      // Resume from what the storage service actually kept.
      offset = await getJson(`/api/account/uploads/${upload.id}`).then(result => result.offset).catch(() => offset);
    }
  }
  await accountRequest(`/api/account/uploads/${upload.id}/complete`);
  update({ sent: file.size, state: "done" });
}

export default function SpaceManager({ space: initial, account, brand }: { space: SpaceView; account: AccountView; brand: string }) {
  const [space, setSpace] = useState(initial);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const notes = useRef<HTMLTextAreaElement>(null);
  // Seconds until processing starts on its own after an upload batch, or null.
  const [autoStart, setAutoStart] = useState<number | null>(null);
  const editable = ["draft", "failed", "ready"].includes(space.status) && space.hosted;
  const uploading = transfers.some(item => item.state === "uploading" || item.state === "retrying");
  const complete = space.uploads.filter(upload => upload.status === "complete");

  const refresh = useCallback(async () => {
    const result = await getJson(`/api/account/spaces/${space.id}`).catch(() => undefined);
    if (result?.space) setSpace(result.space);
    return result?.space as SpaceView | undefined;
  }, [space.id]);
  const waiting = space.status === "queued" || space.status === "processing";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [waiting, refresh]);
  async function add(files: FileList | File[]) {
    setError(""); setMessage("");
    const list = Array.from(files).filter(file => file.size > 0);
    const queued = list.map((file, index) => ({ key: `${Date.now()}-${index}-${file.name}`, name: file.name, size: file.size, sent: 0, state: "uploading" as const }));
    setTransfers(items => [...items.filter(item => item.state !== "done"), ...queued]);
    // Two files at a time keeps the connection busy without starving either upload.
    const pending = list.map((file, index) => ({ file, key: queued[index].key }));
    setAutoStart(null);
    let failed = false;
    await Promise.all([0, 1].map(async () => {
      for (let next = pending.shift(); next; next = pending.shift()) {
        const { file, key } = next;
        const update = (patch: Partial<Transfer>) => setTransfers(items => items.map(item => item.key === key ? { ...item, ...patch } : item));
        try { await uploadFile(space.id, file, update); }
        catch (failure) { failed = true; update({ state: "failed", error: (failure as Error).message }); }
      }
    }));
    const latest = await refresh();
    // New spaces start processing on their own shortly after the upload, unless more files are coming.
    if (!failed && latest && ["draft", "failed"].includes(latest.status)) setAutoStart(15);
  }
  async function remove(id: string, name: string) {
    if (!window.confirm(`Remove ${name}?`)) return;
    setError("");
    try { await accountRequest(`/api/account/uploads/${id}`, undefined, "DELETE"); await refresh(); }
    catch (failure) { setError((failure as Error).message); }
  }
  const startProcessing = useCallback(async () => {
    setAutoStart(null); setBusy(true); setError(""); setMessage("");
    try {
      const result = await accountRequest(`/api/account/spaces/${space.id}/submit`, { notes: notes.current?.value ?? "" });
      setSpace(result.space); setTransfers([]);
      setMessage("Processing started.");
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }, [space.id]);
  useEffect(() => {
    if (autoStart === null) return;
    if (autoStart <= 0) { void startProcessing(); return; }
    const timer = setTimeout(() => setAutoStart(value => value === null ? null : value - 1), 1000);
    return () => clearTimeout(timer);
  }, [autoStart, startProcessing]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void startProcessing();
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
  async function pay() {
    setBusy(true); setError("");
    try { await openBilling("checkout"); } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault(); setDragging(false);
    if (editable && event.dataTransfer.files.length) void add(event.dataTransfer.files);
  }

  const steps = [...(account.billing ? ["Payment"] : []), "Upload", "Processing", "Hosted"];
  const reached = space.status === "unpaid" ? "Payment" : ["draft", "failed"].includes(space.status) ? "Upload"
    : ["queued", "processing"].includes(space.status) ? "Processing" : "Hosted";
  const current = steps.indexOf(reached);
  const detail = space.hosted || space.status === "unpaid" ? describe[space.status] : "This space is offline because billing ended.";

  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={[{ href: "/account", label: "Your spaces" }]} account={account.email} signOut="account" />
    <main className="site-main">
      <a className="site-back" href="/account">← Your spaces</a>
      <div className="site-title">
        <div><span className="site-code">S.{space.id.slice(0, 4)}</span><h1>{space.title}</h1></div>
        <StatusMark status={spaceStatus(space)} label={spaceStatus(space) === "offline" ? "Offline" : undefined} />
      </div>
      <ol className="site-steps" aria-label="Progress">{steps.map((step, index) => <li key={step}
        className={index < current || (index === current && space.status === "ready") ? "done" : index === current ? "current" : ""}
        aria-current={index === current ? "step" : undefined}><b>{String(index + 1).padStart(2, "0")}</b>{step}</li>)}</ol>
      <div className="site-feedback" aria-live="polite">
        {message && <p className="site-note" role="status">{message}</p>}
        {error && <p className="site-alert" role="alert">{error}</p>}
      </div>

      <div className="site-space">
        <div className="site-space-main">
          {space.scene && <section className="site-block" aria-labelledby="scene-heading">
            <SectionHeader title={<span id="scene-heading">Space</span>} code="1.0" />
            <a className="site-plate" href={space.scene.path} target="_blank" rel="noreferrer">
              <img src={space.scene.thumbnail} alt="" width={960} height={640} />
              <span className="site-plate-caption">View space<span aria-hidden="true">↗</span></span>
            </a>
          </section>}

          <section className="site-block" aria-labelledby="files-heading">
            <SectionHeader title={<span id="files-heading">Files</span>} code={space.scene ? "2.0" : "1.0"}>{space.uploads.length > 0 && <span className="site-count">{space.uploads.length}</span>}</SectionHeader>
            {editable && <div className={`site-drop${dragging ? " site-drop-active" : ""}`} onDragOver={event => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)} onDrop={drop}>
              <p className="site-drop-title">Drop capture files here</p>
              <p className="site-hint">Matterport and E57 exports or ZIPs, Gaussian splats (.ply, .spz, .splat, .sog), 360° photos and video, lidar and meshes. Up to {formatBytes(account.maxSpaceBytes)} per space.</p>
              <button type="button" className="site-button" onClick={() => picker.current?.click()}>Choose files</button>
              <input ref={picker} type="file" multiple hidden onChange={event => { if (event.target.files?.length) void add(event.target.files); event.target.value = ""; }} />
            </div>}
            {transfers.length > 0 && <ul className="site-files" aria-label="Uploads in progress">{transfers.map(item => <li key={item.key}>
              <span className="site-file-name">{item.name}</span>
              <span className={`site-file-meta${item.state === "failed" ? " site-file-error" : ""}`}>{item.state === "failed" ? item.error : item.state === "done" ? "Uploaded" : `${item.state === "retrying" ? "Reconnecting · " : ""}${Math.floor(item.sent / item.size * 100)}%`}</span>
              <span className="site-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, item.sent / item.size * 100)}%` }} /></span>
              <progress className="sr-only" max={item.size} value={item.sent} aria-label={`${item.name} upload progress`} />
            </li>)}</ul>}
            {space.uploads.length > 0 ? <ul className="site-files" aria-label="Uploaded files">{space.uploads.map(upload => <li key={upload.id}>
              <span className="site-file-name">{upload.name}</span>
              <span className="site-file-meta">{formatBytes(upload.size)}{upload.status === "uploading" ? " · Incomplete" : ""}</span>
              {(editable || upload.status === "uploading") && <button type="button" className="site-link" onClick={() => remove(upload.id, upload.name)}>Remove</button>}
            </li>)}</ul> : !transfers.length && !editable && <p className="site-hint">No files.</p>}
            {autoStart !== null && <div className="site-callout site-callout-action" role="status">
              <p>Processing starts in <strong>{autoStart} s</strong>.</p>
              <div className="site-actions"><button type="button" className="site-button" onClick={() => void startProcessing()}>Start now</button>
                <button type="button" className="site-link" onClick={() => setAutoStart(null)}>Wait, I am adding more files</button></div>
            </div>}
            {editable && <form className="site-form site-submit" onSubmit={submit}>
              <div className="site-field"><label htmlFor="notes">Notes for processing <span className="site-optional">Optional</span></label>
                <textarea className="site-input" ref={notes} id="notes" name="notes" maxLength={2000} rows={3} defaultValue={space.notes ?? ""} placeholder="Capture device, what the space is, anything we should know" /></div>
              <div><button type="submit" className="site-button" disabled={busy || uploading || !complete.length}>{space.status === "ready" ? "Reprocess with these files" : "Start processing"}<span aria-hidden="true">→</span></button></div>
            </form>}
          </section>
        </div>

        <aside className="site-space-aside" aria-label="Details">
          <div className="site-aside-block">
            <h3>Status</h3>
            <p>{detail}</p>
            {waiting && space.job?.progress && <p className="site-progress" aria-live="polite"><span>Latest step</span>{space.job.progress}</p>}
            {space.message && !waiting && <blockquote className="site-quote">{space.message}</blockquote>}
            {space.status === "unpaid" && <button type="button" className="site-button site-button-block" disabled={busy} onClick={pay}>Complete payment<span aria-hidden="true">→</span></button>}
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
          </div>}
          <div className="site-aside-block">
            <h3>Settings</h3>
            {!space.scene && space.status !== "processing" && <form className="site-form" onSubmit={event => { event.preventDefault(); void patch({ title: new FormData(event.currentTarget).get("title") }, "Title saved."); }}>
              <div className="site-field"><label htmlFor="title">Title</label><input className="site-input" id="title" name="title" defaultValue={space.title} required maxLength={200} /></div>
              <div><button type="submit" className="site-button site-button-secondary" disabled={busy}>Save title</button></div>
            </form>}
            <button type="button" className="site-link site-danger" disabled={busy} onClick={destroy}>Delete this space</button>
          </div>
        </aside>
      </div>
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
  </div></div>;
}
