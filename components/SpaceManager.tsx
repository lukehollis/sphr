"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { accountRequest } from "./AccountAuth";
import { AccountHeader, openBilling, statusLabels } from "./AccountDashboard";
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

export default function SpaceManager({ space: initial, account }: { space: SpaceView; account: AccountView }) {
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

  return <main className="space-library admin-library account-page"><div className="library-shell">
    <AccountHeader title={space.title} back={{ href: "/account", label: "Your spaces" }} />
    <div className="admin-feedback" aria-live="polite">{message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}</div>
    <div className="account-space-layout">
      <section className="account-panel" aria-labelledby="status-heading">
        <h2 id="status-heading">{statusLabels[space.status]}</h2>
        <p>{space.hosted || space.status === "unpaid" ? describe[space.status] : "This space is offline because billing ended."}</p>
        {waiting && space.job?.progress && <p className="account-progress" aria-live="polite"><span>Latest step</span>{space.job.progress}</p>}
        {space.message && !waiting && <blockquote className="account-message">{space.message}</blockquote>}
        {space.status === "unpaid" && <button type="button" disabled={busy} onClick={pay}>Complete payment</button>}
        {space.scene && <div className="account-scene">
          <a className="account-scene-link" href={space.scene.path} target="_blank" rel="noreferrer">
            <img src={space.scene.thumbnail} alt="" width={960} height={640} /><span>View space ↗</span></a>
          <div className="admin-visibility"><label htmlFor="visibility">Visibility</label>
            <select id="visibility" value={space.scene.public ? "public" : "private"} disabled={busy || !space.hosted}
              onChange={event => patch({ public: event.target.value === "public" }, event.target.value === "public" ? "Anyone with the link can now open this space." : "Only you can open this space now.")}>
              <option value="private">Private</option><option value="public">Public</option></select></div>
          <p className="admin-help">{space.scene.public ? "Anyone with the link can open it." : "Only you can open it while it is private."}</p>
          <div className="admin-edit"><a href={`/account/spaces/${space.id}/edit`}>Edit title, start view and thumbnail</a></div>
        </div>}
      </section>

      <section className="account-panel" aria-labelledby="files-heading">
        <h2 id="files-heading">Files</h2>
        {editable && <div className={`account-drop${dragging ? " account-drop-active" : ""}`} onDragOver={event => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)} onDrop={drop}>
          <p>Drop capture files here, or</p>
          <button type="button" onClick={() => picker.current?.click()}>Choose files</button>
          <input ref={picker} type="file" multiple hidden onChange={event => { if (event.target.files?.length) void add(event.target.files); event.target.value = ""; }} />
          <p className="admin-help">Matterport E57 or ZIP exports, Gaussian splats (.ply, .spz, .splat, .sog), 360° photos, video, or anything else from your capture. Up to {formatBytes(account.maxSpaceBytes)} per space.</p>
        </div>}
        {transfers.length > 0 && <ul className="account-files" aria-label="Uploads in progress">{transfers.map(item => <li key={item.key}>
          <span className="account-file-name">{item.name}</span>
          <span className="account-file-meta">{item.state === "failed" ? item.error : item.state === "done" ? "Uploaded" : `${item.state === "retrying" ? "Reconnecting · " : ""}${Math.floor(item.sent / item.size * 100)}%`}</span>
          <progress max={item.size} value={item.sent} aria-label={`${item.name} upload progress`} />
        </li>)}</ul>}
        {space.uploads.length > 0 ? <ul className="account-files" aria-label="Uploaded files">{space.uploads.map(upload => <li key={upload.id}>
          <span className="account-file-name">{upload.name}</span>
          <span className="account-file-meta">{formatBytes(upload.size)}{upload.status === "uploading" ? " · Incomplete" : ""}</span>
          {(editable || upload.status === "uploading") && <button type="button" className="account-link-button" onClick={() => remove(upload.id, upload.name)}>Remove</button>}
        </li>)}</ul> : !transfers.length && <p className="admin-help">No files yet.</p>}
        {autoStart !== null && <div className="account-autostart" role="status">
          <p>Processing starts in {autoStart} s.</p>
          <div><button type="button" onClick={() => void startProcessing()}>Start now</button>
            <button type="button" className="account-link-button" onClick={() => setAutoStart(null)}>Wait, I am adding more files</button></div>
        </div>}
        {editable && <form className="admin-form account-submit" onSubmit={submit}>
          <label htmlFor="notes">Notes for processing (optional)</label>
          <textarea ref={notes} id="notes" name="notes" maxLength={2000} rows={3} defaultValue={space.notes ?? ""} placeholder="Capture device, what the space is, anything we should know" />
          <button type="submit" disabled={busy || uploading || !complete.length}>{space.status === "ready" ? "Reprocess with these files" : "Submit for processing"}</button>
        </form>}
      </section>

      <section className="account-panel" aria-labelledby="settings-heading">
        <h2 id="settings-heading">Settings</h2>
        {!space.scene && space.status !== "processing" && <form className="admin-form" onSubmit={event => { event.preventDefault(); void patch({ title: new FormData(event.currentTarget).get("title") }, "Title saved."); }}>
          <label htmlFor="title">Title</label><input id="title" name="title" defaultValue={space.title} required maxLength={200} />
          <button type="submit" disabled={busy}>Save title</button>
        </form>}
        <button type="button" className="account-danger" disabled={busy} onClick={destroy}>Delete space</button>
      </section>
    </div>
  </div></main>;
}
