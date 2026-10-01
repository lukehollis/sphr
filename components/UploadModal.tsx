"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { accountRequest } from "./AccountAuth";
import { reportError, track } from "./Analytics";
import { ConstructionDrawing } from "./site/Chrome";
import PlanPicker, { OpenSourceNote } from "./PlanPicker";
import { formatBytes } from "@/lib/bytes";
import { formatMoney, formatPeriod } from "@/lib/price";
import { fromList, getJson, keepCaptures, readDrop, titleFromFiles, uploadFile, type PickedFile, type Transfer } from "./uploads";
import type { Plan } from "@/lib/server/billing";
import type { SpaceView } from "@/lib/server/customer-spaces";

/*
 * Adding a space: a full-screen sheet that takes dropped files or folders. The space is
 * created at once with a title taken from the file names. When hosting has not started
 * yet, the sheet shows the plans with pay as you go chosen and payment opens in a new
 * tab. When the customer's plan is full, the files wait while they change plans. The
 * files upload while this page stays open, even after the sheet is closed, and
 * processing starts on its own shortly after the upload.
 */

export type BatchPhase = "creating" | "payment" | "full" | "uploading" | "countdown" | "held" | "submitting" | "processing" | "error";

export type Batch = {
  key: string;
  spaceId?: string;
  title: string;
  phase: BatchPhase;
  transfers: Transfer[];
  checkoutUrl?: string;
  checkoutOpened?: boolean;
  /** The plan chosen for payment, or null for pay as you go. */
  plan?: string | null;
  /** A new payment link is on its way after the plan changed. */
  preparing?: boolean;
  countdown?: number;
  error?: string;
  /** New files count down to processing; files added to a hosted space wait for a click. */
  autoStart: boolean;
};

const AUTO_START_SECONDS = 10;
export const awaitingPaymentKey = "sphr-awaiting-payment";
export const uploadsChannel = "sphr-uploads";

const busyPhases = new Set<BatchPhase>(["creating", "payment", "full", "uploading", "countdown", "held", "submitting"]);
const openPhases = ["creating", "payment", "full", "uploading", "countdown", "held"];
export const batchActive = (batch: Batch) => busyPhases.has(batch.phase);
const moving = (transfer: Transfer) => transfer.state === "waiting" || transfer.state === "uploading" || transfer.state === "retrying";

function remember(spaceId: string | null) {
  try {
    if (spaceId) localStorage.setItem(awaitingPaymentKey, JSON.stringify({ spaceId, at: Date.now() }));
    else localStorage.removeItem(awaitingPaymentKey);
  } catch { /* Private windows may refuse storage; the other tab then shows its usual notice. */ }
}

/** Runs upload batches for this page. Uploads continue while the page stays open. */
export function useUploadBatches(onChange: () => void) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const queues = useRef(new Map<string, Array<PickedFile & { key: string }>>());
  const picked = useRef(new Map<string, PickedFile & { key: string }>());
  const running = useRef(new Map<string, number>());
  // Kept outside React state: uploads start before the next render has stored the space.
  const spaceOf = useRef(new Map<string, string>());
  const change = useRef(onChange);
  change.current = onChange;
  const latest = useRef(batches);
  latest.current = batches;

  const patch = useCallback((key: string, update: Partial<Batch> | ((batch: Batch) => Partial<Batch>)) => {
    setBatches(items => items.map(item => item.key === key ? { ...item, ...(typeof update === "function" ? update(item) : update) } : item));
  }, []);
  const patchTransfer = useCallback((key: string, transfer: string, update: Partial<Transfer>) => {
    setBatches(items => items.map(item => item.key !== key ? item
      : { ...item, transfers: item.transfers.map(entry => entry.key === transfer ? { ...entry, ...update } : entry) }));
  }, []);

  /** Two files at a time keeps the connection busy without starving either upload. */
  const pump = useCallback((key: string) => {
    const spaceId = spaceOf.current.get(key);
    if (!spaceId) return;
    const queue = queues.current.get(key) ?? [];
    while ((running.current.get(key) ?? 0) < 2 && queue.length) {
      const next = queue.shift()!;
      const transferKey = next.key;
      running.current.set(key, (running.current.get(key) ?? 0) + 1);
      void uploadFile(spaceId, next.file, update => patchTransfer(key, transferKey, update))
        .catch(failure => {
          track("upload_error", { step: "upload", message: (failure as Error).message });
          patchTransfer(key, transferKey, { state: "failed", error: (failure as Error).message });
        })
        .finally(() => {
          running.current.set(key, (running.current.get(key) ?? 1) - 1);
          pump(key);
          if (!(running.current.get(key) ?? 0) && !(queues.current.get(key)?.length)) {
            // Every file has settled: count down to processing unless something failed.
            setBatches(items => items.map(item => {
              if (item.key !== key || item.phase !== "uploading") return item;
              if (!item.transfers.length || item.transfers.some(entry => entry.state === "failed")) return item;
              return item.autoStart ? { ...item, phase: "countdown", countdown: AUTO_START_SECONDS } : { ...item, phase: "held" };
            }));
            change.current();
          }
        });
    }
  }, [patchTransfer]);

  const enqueue = useCallback((key: string, files: PickedFile[]) => {
    const stamped = files.map((item, index) => ({ ...item, key: `${Date.now()}-${index}-${item.path}` }));
    for (const item of stamped) picked.current.set(item.key, item);
    queues.current.set(key, [...(queues.current.get(key) ?? []), ...stamped]);
    const transfers: Transfer[] = stamped.map(item => ({ key: item.key, name: item.file.name, size: item.file.size, sent: 0, state: "waiting" }));
    setBatches(items => items.map(item => item.key !== key ? item : {
      ...item, transfers: [...item.transfers, ...transfers],
      // New files during the countdown mean the customer is still adding: wait for them.
      phase: item.phase === "countdown" || item.phase === "held" ? "uploading" : item.phase, countdown: undefined
    }));
  }, []);

  const begin = useCallback((key: string) => {
    patch(key, { phase: "uploading", checkoutUrl: undefined });
    // State settles before the pump reads the space ID.
    setTimeout(() => pump(key), 0);
  }, [patch, pump]);

  /** Creates the space, then pays (if needed) and uploads. A full plan holds the files until the plan changes. */
  const create = useCallback(async (key: string, title: string) => {
    patch(key, { phase: "creating", error: undefined });
    try {
      const result = await accountRequest("/api/account/spaces", { title });
      spaceOf.current.set(key, result.space.id);
      patch(key, { spaceId: result.space.id });
      change.current();
      const checkout = result.checkout ?? result.portal;
      if (result.space.status === "unpaid") {
        // An open payment keeps the plan chosen for it.
        patch(key, { phase: "payment", checkoutUrl: checkout, plan: result.plan ?? null, error: result.error });
        remember(result.space.id);
      } else begin(key);
    } catch (failure) {
      const { message, data } = failure as Error & { data?: { planFull?: boolean } };
      track(data?.planFull ? "plan_full" : "upload_error", { step: "create", message });
      patch(key, { phase: data?.planFull ? "full" : "error", error: message });
    }
  }, [begin, patch]);

  /** Starts a space titled after the files. */
  const startNew = useCallback(async (files: PickedFile[]) => {
    const key = `batch-${Date.now()}`;
    const title = titleFromFiles(files);
    setBatches(items => [...items, { key, title, phase: "creating", transfers: [], autoStart: true }]);
    enqueue(key, files);
    await create(key, title);
    return key;
  }, [create, enqueue]);

  /**
   * Chooses how a first space is paid for. Payment opens from a plain link, so a new link
   * is prepared as soon as the plan changes rather than after the click.
   */
  const choosePlan = useCallback(async (key: string, plan: string) => {
    const batch = latest.current.find(item => item.key === key);
    if (!batch || batch.phase !== "payment") return;
    patch(key, { plan, preparing: true, checkoutOpened: false, error: undefined });
    track("plan_chosen", { plan });
    try {
      const result = await accountRequest("/api/account/billing/checkout", { plan });
      if (result.paid) { begin(key); change.current(); return; }
      patch(key, item => item.plan === plan ? { checkoutUrl: result.url, preparing: false } : {});
    } catch (failure) {
      patch(key, item => item.plan === plan ? { preparing: false, checkoutUrl: undefined, error: (failure as Error).message } : {});
    }
  }, [begin, patch]);

  /** Moves a full plan to one with room, then creates the waiting space. */
  const switchPlan = useCallback(async (key: string, plan: string) => {
    const batch = latest.current.find(item => item.key === key);
    if (!batch || batch.phase !== "full") return;
    patch(key, { preparing: true, error: undefined });
    try {
      await accountRequest("/api/account/billing/plan", { plan });
      change.current();
      patch(key, { preparing: false });
      await create(key, batch.title);
    } catch (failure) {
      patch(key, { preparing: false, error: (failure as Error).message });
    }
  }, [create, patch]);

  /** Adds files to a space that already exists. A hosted space is reprocessed only on request. */
  const startExisting = useCallback((space: { id: string; title: string; status: string }, files: PickedFile[]) => {
    const key = `batch-${Date.now()}`;
    spaceOf.current.set(key, space.id);
    setBatches(items => [...items, { key, spaceId: space.id, title: space.title, phase: "uploading", transfers: [], autoStart: space.status !== "ready" }]);
    enqueue(key, files);
    setTimeout(() => pump(key), 0);
    return key;
  }, [enqueue, pump]);

  const addFiles = useCallback((key: string, files: PickedFile[]) => {
    const batch = latest.current.find(item => item.key === key);
    if (!batch || !openPhases.includes(batch.phase)) return;
    enqueue(key, files);
    if (!["creating", "payment", "full"].includes(batch.phase)) setTimeout(() => pump(key), 0);
  }, [enqueue, pump]);

  const submit = useCallback(async (key: string) => {
    const spaceId = spaceOf.current.get(key);
    if (!spaceId) return;
    patch(key, { phase: "submitting", countdown: undefined, error: undefined });
    try {
      await accountRequest(`/api/account/spaces/${spaceId}/submit`, { notes: "" });
      patch(key, { phase: "processing" });
      remember(null);
    } catch (failure) {
      track("upload_error", { step: "submit", message: (failure as Error).message });
      patch(key, { phase: "error", error: (failure as Error).message });
    }
    change.current();
  }, [patch]);

  const hold = useCallback((key: string) => patch(key, { phase: "held", countdown: undefined }), [patch]);

  /** Sends the failed files again. */
  const retry = useCallback((key: string) => {
    const batch = latest.current.find(item => item.key === key);
    if (!batch) return;
    const failed = batch.transfers.filter(entry => entry.state === "failed");
    queues.current.set(key, [...(queues.current.get(key) ?? []), ...failed.map(entry => picked.current.get(entry.key)!).filter(Boolean)]);
    patch(key, item => ({ phase: "uploading", error: undefined,
      transfers: item.transfers.map(entry => entry.state === "failed" ? { ...entry, state: "waiting" as const, sent: 0, error: undefined } : entry) }));
    setTimeout(() => pump(key), 0);
  }, [patch, pump]);

  /** Drops the failed files (and their unfinished records, which would hold up processing) and carries on with the rest. */
  const skipFailed = useCallback((key: string) => {
    for (const entry of latest.current.find(item => item.key === key)?.transfers ?? []) {
      if (entry.state === "failed" && entry.uploadId) void accountRequest(`/api/account/uploads/${entry.uploadId}`, undefined, "DELETE").catch(() => undefined);
    }
    setBatches(items => items.map(item => {
      if (item.key !== key) return item;
      const transfers = item.transfers.filter(entry => entry.state !== "failed");
      const settled = transfers.length > 0 && transfers.every(entry => entry.state === "done");
      return { ...item, transfers, phase: settled ? (item.autoStart ? "countdown" : "held") : item.phase, countdown: settled && item.autoStart ? AUTO_START_SECONDS : undefined };
    }));
  }, []);

  const rename = useCallback(async (key: string, title: string) => {
    const batch = latest.current.find(item => item.key === key);
    const clean = title.trim().slice(0, 200);
    if (!batch || !clean) return;
    patch(key, { title: clean });
    const spaceId = spaceOf.current.get(key);
    if (!spaceId) return;
    try { await accountRequest(`/api/account/spaces/${spaceId}`, { title: clean }, "PATCH"); change.current(); }
    catch (failure) { patch(key, { error: (failure as Error).message }); }
  }, [patch]);

  /** Gives up before paying: the empty space is removed again. */
  const cancel = useCallback(async (key: string) => {
    const batch = latest.current.find(item => item.key === key);
    track("upload_cancelled", { phase: batch?.phase ?? "unknown", paymentOpened: Boolean(batch?.checkoutOpened) });
    queues.current.delete(key);
    setBatches(items => items.filter(item => item.key !== key));
    remember(null);
    if (batch?.spaceId && (batch.phase === "payment" || batch.phase === "error") && !batch.transfers.some(entry => entry.state === "done")) {
      await accountRequest(`/api/account/spaces/${batch.spaceId}`, undefined, "DELETE").catch(() => undefined);
    }
    change.current();
  }, []);

  const dismiss = useCallback((key: string) => setBatches(items => items.filter(item => item.key !== key)), []);

  const markCheckoutOpened = useCallback((key: string) => {
    track("checkout_opened", { plan: latest.current.find(item => item.key === key)?.plan ?? "" });
    patch(key, { checkoutOpened: true });
  }, [patch]);

  // Countdown to processing.
  const counting = batches.some(batch => batch.phase === "countdown");
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => {
      for (const batch of latest.current) {
        if (batch.phase !== "countdown") continue;
        if ((batch.countdown ?? 0) <= 1) void submit(batch.key);
        else patch(batch.key, { countdown: (batch.countdown ?? AUTO_START_SECONDS) - 1 });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [counting, patch, submit]);

  // Leaving during the countdown starts processing at once instead of never.
  useEffect(() => {
    if (!counting) return;
    const leave = () => {
      for (const batch of latest.current) {
        const spaceId = spaceOf.current.get(batch.key);
        if (batch.phase !== "countdown" || !spaceId) continue;
        void fetch(`/api/account/spaces/${spaceId}/submit`, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: "" }) }).catch(() => undefined);
      }
    };
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [counting]);

  // Payment happens in another tab; watch for the space to leave "unpaid".
  const paying = batches.filter(batch => batch.phase === "payment" && batch.spaceId).map(batch => `${batch.key}:${batch.spaceId}`).join(",");
  useEffect(() => {
    if (!paying) return;
    const timer = setInterval(async () => {
      for (const batch of latest.current) {
        if (batch.phase !== "payment" || !batch.spaceId) continue;
        const result = await getJson(`/api/account/spaces/${batch.spaceId}`).catch(() => undefined);
        // The marker stays until processing starts, so the checkout tab can still read it.
        if (result?.space && result.space.status !== "unpaid") { begin(batch.key); change.current(); }
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [paying, begin]);

  // Leaving the page stops uploads that are still running.
  const unfinished = batches.some(batch => batch.phase === "payment" || batch.phase === "full" || batch.transfers.some(moving));
  useEffect(() => {
    if (!unfinished) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unfinished]);

  // The tab Checkout returns to asks whether this one still holds files waiting to upload, so it
  // can say honestly where the upload is (a phone may have suspended or discarded this tab).
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(uploadsChannel);
    channel.onmessage = event => {
      if (event.data?.type === "who-has-files" && latest.current.some(batch => batchActive(batch) && batch.transfers.some(entry => entry.state !== "done"))) {
        channel.postMessage({ type: "has-files" });
      }
    };
    return () => channel.close();
  }, []);

  return { batches, startNew, startExisting, addFiles, submit, hold, retry, skipFailed, rename, cancel, dismiss, markCheckoutOpened, choosePlan, switchPlan };
}

export type Uploads = ReturnType<typeof useUploadBatches>;

/** Bytes sent and an estimate of the time left, from the last few seconds of progress. */
function useRate(sent: number, total: number, active: boolean) {
  const samples = useRef<Array<[number, number]>>([]);
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!active) { samples.current = []; setLeft(null); return; }
    const now = Date.now();
    samples.current = [...samples.current.filter(([time]) => now - time < 12000), [now, sent]];
    const [first] = samples.current;
    if (!first || now - first[0] < 3000) return;
    const rate = (sent - first[1]) / ((now - first[0]) / 1000);
    setLeft(rate > 0 ? (total - sent) / rate : null);
  }, [sent, total, active]);
  return left;
}

function timeLeft(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  if (seconds < 50) return "Less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
  const hours = Math.round(minutes / 6) / 10;
  return `About ${hours} ${hours === 1 ? "hour" : "hours"} left`;
}

function Pickers({ onFiles, compact = false }: { onFiles: (files: PickedFile[]) => void; compact?: boolean }) {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const take = (list: FileList | null) => { if (list?.length) onFiles(keepCaptures(fromList(list))); };
  // Phones and tablets ignore folder picking and would show the ordinary file picker under a misleading label.
  const [folders, setFolders] = useState(true);
  useEffect(() => setFolders(!/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) && !(/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)), []);
  return <div className="upload-pickers">
    <button type="button" className={`site-button${compact ? " site-button-secondary" : ""}`} onClick={() => files.current?.click()}>Upload files</button>
    {folders && <button type="button" className="site-button site-button-secondary" onClick={() => folder.current?.click()}>Upload a folder</button>}
    <input ref={files} type="file" multiple hidden onChange={event => { take(event.target.files); event.target.value = ""; }} />
    <input ref={folder} type="file" multiple hidden {...{ webkitdirectory: "" }} onChange={event => { take(event.target.files); event.target.value = ""; }} />
  </div>;
}

function Meter({ value, label }: { value: number; label: string }) {
  return <span className="upload-meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
    <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
  </span>;
}

/** How new spaces are paid for, shown when they are created. */
export type PlanChoice = {
  plans: Plan[];
  /** The plan the account is on, if hosting is active. */
  current: string | null;
  /** Spaces the account has, which a plan must cover. */
  spaces: number;
  brand: string;
  sourceUrl: string | null;
};

export default function UploadModal({ open, onClose, uploads, batchKey, onBatch, existing, maxBytes, priceHint, billing }: {
  open: boolean;
  onClose: () => void;
  uploads: Uploads;
  batchKey: string | null;
  onBatch: (key: string) => void;
  /** Adding files to this space instead of creating one. */
  existing?: SpaceView;
  maxBytes: number;
  priceHint?: string;
  billing?: PlanChoice;
}) {
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const batch = uploads.batches.find(item => item.key === batchKey);
  const close = useCallback(() => {
    track("upload_closed", { phase: batch?.phase ?? "empty", files: batch?.transfers.length ?? 0, paymentOpened: Boolean(batch?.checkoutOpened) });
    onClose();
  }, [batch, onClose]);
  useEffect(() => { if (open) track("upload_opened", { existing: Boolean(existing) }); }, [open, existing]);

  const receive = useCallback(async (files: PickedFile[]) => {
    const usable = keepCaptures(files);
    const kinds = [...new Set(files.map(item => item.file.name.split(".").pop()?.toLowerCase() ?? ""))].filter(Boolean).slice(0, 10).join(",");
    track(usable.length ? "files_chosen" : "files_rejected", { count: usable.length, skipped: files.length - usable.length, kinds,
      bytes: usable.reduce((total, item) => total + item.file.size, 0) });
    if (!usable.length) return;
    if (batch && openPhases.includes(batch.phase)) uploads.addFiles(batch.key, usable);
    else onBatch(existing ? uploads.startExisting(existing, usable) : await uploads.startNew(usable));
  }, [batch, existing, onBatch, uploads]);

  function drop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    setReading(true);
    readDrop(event.dataTransfer).then(receive).catch(failure => reportError("drop", failure)).finally(() => setReading(false));
  }

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key !== "Tab" || !dialog.current) return;
      // Keep keyboard focus inside the sheet.
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([type=file]):not([disabled])"));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    document.documentElement.classList.add("upload-modal-open");
    return () => {
      document.removeEventListener("keydown", key);
      document.documentElement.classList.remove("upload-modal-open");
      previous?.focus?.();
    };
  }, [open, close]);

  const transfers = batch?.transfers ?? [];
  const total = transfers.reduce((sum, item) => sum + item.size, 0);
  const sent = transfers.reduce((sum, item) => sum + Math.min(item.sent, item.size), 0);
  const done = transfers.filter(item => item.state === "done").length;
  const failed = transfers.filter(item => item.state === "failed");
  const uploadingNow = transfers.some(item => item.state === "uploading" || item.state === "retrying");
  const left = useRate(sent, total, uploadingNow);
  if (!open) return null;

  const heading = existing ? `Add files to ${existing.title}` : batch?.phase === "processing" ? "Space added" : "Add a space";
  const canAdd = !batch || openPhases.includes(batch.phase);

  return <div className={`upload-modal${dragging ? " upload-modal-over" : ""}`} role="dialog" aria-modal="true" aria-labelledby="upload-modal-title"
    ref={dialog} tabIndex={-1}
    onDragOver={event => { if (canAdd) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false); }}
    onDrop={event => { if (canAdd) drop(event); }}>
    <div className="upload-modal-bar">
      <h2 id="upload-modal-title">{heading}</h2>
      <button type="button" className="upload-modal-close" onClick={close}>
        {batch && batchActive(batch) && batch.phase !== "payment" && batch.phase !== "full" ? "Close, keep uploading" : "Close"}<span aria-hidden="true">✕</span>
      </button>
    </div>

    {!batch ? <div className={`upload-drop${dragging ? " upload-drop-over" : ""}`}>
      <ConstructionDrawing className="upload-drop-drawing" />
      <p className="upload-drop-title">{reading ? "Reading your files…" : dragging ? "Drop to add them" : "Drop capture files or a folder here"}</p>
      <Pickers onFiles={files => void receive(files)} />
      <p className="upload-drop-hint">E57 and Matterport exports, Gaussian splats, 360 photos and video, point clouds and meshes, up to {formatBytes(maxBytes)} per space.
        {existing ? "" : " The title comes from your file names."}</p>
      {priceHint && <p className="upload-drop-hint">{priceHint}</p>}
    </div>

    : <div className="upload-batch">
      <div className="upload-batch-main">
        {!existing && <div className="upload-title">
          <label htmlFor="upload-title">Title</label>
          <input id="upload-title" className="upload-title-input" defaultValue={batch.title} key={batch.key} maxLength={200}
            onBlur={event => { if (event.target.value.trim() && event.target.value.trim() !== batch.title) void uploads.rename(batch.key, event.target.value); }}
            onKeyDown={event => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} />
          <p className="site-hint">Taken from your file names. You can change it any time.</p>
        </div>}

        <Status batch={batch} uploads={uploads} total={total} sent={sent} done={done} failed={failed.length} left={left} onClose={close} existing={Boolean(existing)}
          billing={billing} />

        {transfers.length > 0 && <ul className="upload-files" aria-label="Files">
          {transfers.map(item => <li key={item.key} className={`upload-file upload-file-${item.state}`}>
            <span className="upload-file-name">{item.name}</span>
            <span className="upload-file-meta">{item.state === "failed" ? item.error
              : item.state === "done" ? formatBytes(item.size)
              : item.state === "waiting" ? `${formatBytes(item.size)}, waiting`
              : `${item.state === "retrying" ? "Reconnecting, " : ""}${Math.floor(item.sent / item.size * 100)}%`}</span>
            <Meter value={item.sent / item.size * 100} label={`${item.name} upload progress`} />
          </li>)}
        </ul>}
      </div>

      {canAdd && <div className={`upload-more${dragging ? " upload-more-over" : ""}`}>
        <p><strong>Add more files</strong>Drop them anywhere on this sheet, or choose them.</p>
        <Pickers compact onFiles={files => void receive(files)} />
      </div>}
    </div>}
  </div>;
}

/** A new space the current plan has no room for: the files wait while the customer picks a plan with room. */
function PlanFull({ batch, uploads, billing }: { batch: Batch; uploads: Uploads; billing?: PlanChoice }) {
  const plans = billing?.plans ?? [];
  const needed = (billing?.spaces ?? 0) + 1;
  // The cheapest plan with room comes chosen.
  const cost = (plan: Plan) => plan.spaces === null ? plan.amount * needed : plan.amount;
  const fits = plans.filter(plan => plan.id !== billing?.current && (plan.spaces === null || plan.spaces >= needed)).sort((a, b) => cost(a) - cost(b));
  const [choice, setChoice] = useState<string | null>(null);
  const selected = choice ?? fits[0]?.id ?? null;
  const target = plans.find(plan => plan.id === selected);
  const current = plans.find(plan => plan.id === billing?.current);
  return <div className="upload-status upload-status-action upload-status-plans">
    <h3>Your plan is full</h3>
    <p>{current?.spaces ? `${current.name} covers ${current.spaces} spaces and all of them are in use.` : batch.error}
      {" "}Pick a plan with room and your files upload right after.</p>
    {plans.length > 0 && <PlanPicker plans={plans} selected={selected} needed={needed} current={billing?.current} name={`switch-${batch.key}`}
      label="Plans with room" disabled={batch.preparing} onSelect={id => { if (id !== billing?.current) setChoice(id); }} />}
    <div className="site-actions">
      {target && <button type="button" className="site-button" disabled={batch.preparing}
        onClick={() => void uploads.switchPlan(batch.key, target.id)}>{batch.preparing ? "Changing plans…" : `Switch to ${target.spaces === null ? "pay as you go" : target.name}`}
        <span aria-hidden="true">→</span></button>}
      <button type="button" className="site-link" onClick={() => void uploads.cancel(batch.key)}>Cancel</button>
    </div>
    <p className="site-hint">The change applies now, and your next invoice is prorated for the rest of this period.</p>
  </div>;
}

function Status({ batch, uploads, total, sent, done, failed, left, onClose, existing, billing }: {
  batch: Batch; uploads: Uploads; total: number; sent: number; done: number; failed: number; left: number | null; onClose: () => void; existing: boolean;
  billing?: PlanChoice;
}) {
  const count = batch.transfers.length;
  const files = `${count} ${count === 1 ? "file" : "files"}`;
  if (batch.phase === "creating") return <div className="upload-status"><h3>Setting up the space</h3><p>{files}, {formatBytes(total)}</p></div>;

  if (batch.phase === "payment") {
    const plans = billing?.plans ?? [];
    const plan = plans.find(item => item.id === batch.plan) ?? plans[0];
    const price = plan && `${formatMoney(plan.amount, plan.currency)} ${formatPeriod(plan.interval, plan.intervalCount)}`;
    return <div className="upload-status upload-status-action upload-status-plans">
      <h3>{batch.checkoutOpened ? "Waiting for payment" : "Start hosting"}</h3>
      {plan && <p>{plan.spaces === null ? `You're on pay as you go, so each space you upload adds ${price}.${plans.length > 1 ? " A plan covers a set number of spaces for one price." : ""}`
        : `${plan.name} covers up to ${plan.spaces} spaces for ${price}.`}</p>}
      {plans.length > 1 && <PlanPicker plans={plans} selected={plan?.id ?? null} needed={billing?.spaces || 1} name={`plan-${batch.key}`}
        label="How you pay" disabled={batch.preparing} onSelect={id => void uploads.choosePlan(batch.key, id)} />}
      {billing && <OpenSourceNote brand={billing.brand} sourceUrl={billing.sourceUrl} />}
      {batch.error && <p className="site-alert" role="alert">{batch.error}</p>}
      <div className="site-actions">
        {batch.preparing ? <button type="button" className="site-button site-button-accent" disabled>Preparing payment…</button>
          : batch.checkoutUrl ? <a className="site-button site-button-accent" href={batch.checkoutUrl} target="_blank" rel="noopener" onClick={() => uploads.markCheckoutOpened(batch.key)}>
            {batch.checkoutOpened ? "Open payment again" : "Continue to payment"}<span aria-hidden="true">↗</span></a>
          : <button type="button" className="site-button site-button-accent" onClick={() => void uploads.choosePlan(batch.key, plan?.id ?? "")}>Try payment again</button>}
        <button type="button" className="site-link" onClick={() => void uploads.cancel(batch.key)}>Cancel</button>
      </div>
      <p className="site-hint">{batch.checkoutOpened ? "Finish paying in the other tab. Your files start uploading here as soon as payment goes through."
        : "Payment opens in a new tab. Your files start uploading here as soon as it goes through."}</p>
    </div>;
  }

  if (batch.phase === "full") return <PlanFull batch={batch} uploads={uploads} billing={billing} />;

  if (batch.phase === "uploading" && !count) return <div className="upload-status"><h3>Add your files</h3><p>Drop them on this sheet or choose them below.</p></div>;

  if (batch.phase === "uploading") return <div className="upload-status">
    <h3>{failed ? `${failed} ${failed === 1 ? "file" : "files"} did not upload` : `Uploading ${files}`}</h3>
    <p>{formatBytes(sent)} of {formatBytes(total)}{left !== null && !failed ? `. ${timeLeft(left)}` : ""}</p>
    <Meter value={total ? sent / total * 100 : 0} label="Upload progress" />
    {failed ? <div className="site-actions">
      <button type="button" className="site-button" onClick={() => uploads.retry(batch.key)}>Try again</button>
      {done > 0 && <button type="button" className="site-link" onClick={() => uploads.skipFailed(batch.key)}>Leave {failed === 1 ? "it" : "them"} out</button>}
    </div> : <p className="site-hint">You can close this sheet. Uploads keep going while this page stays open.</p>}
  </div>;

  if (batch.phase === "countdown" || batch.phase === "held") return <div className="upload-status upload-status-action">
    <h3>Upload complete</h3>
    <p>{batch.phase === "countdown" ? `Processing starts in ${batch.countdown} s.` : existing && !batch.autoStart
      ? "The space stays as it is until you process it again with these files." : "Start processing when every file is here."}</p>
    <div className="site-actions">
      <button type="button" className="site-button" onClick={() => void uploads.submit(batch.key)}>{batch.phase === "countdown" ? "Start now"
        : existing && !batch.autoStart ? "Reprocess with these files" : "Start processing"}<span aria-hidden="true">→</span></button>
      {batch.phase === "countdown" && <button type="button" className="site-link" onClick={() => uploads.hold(batch.key)}>Wait, I am adding more files</button>}
    </div>
  </div>;

  if (batch.phase === "submitting") return <div className="upload-status"><h3>Starting processing</h3><p>{files}, {formatBytes(total)}</p></div>;

  if (batch.phase === "processing") return <div className="upload-status upload-status-done">
    <h3>Processing started</h3>
    <p>An agent is turning your files into a space. We will email you when it is ready, so you can close this sheet.</p>
    <div className="site-actions">
      <button type="button" className="site-button" onClick={() => { uploads.dismiss(batch.key); onClose(); }}>Done</button>
      {!existing && batch.spaceId && <a className="site-link" href={`/account/spaces/${batch.spaceId}`}>Open the space page</a>}
    </div>
  </div>;

  return <div className="upload-status upload-status-action">
    <h3>Something went wrong</h3>
    <p className="site-alert" role="alert">{batch.error ?? "Try again."}</p>
    <div className="site-actions">
      {batch.spaceId && done > 0 && <button type="button" className="site-button" onClick={() => void uploads.submit(batch.key)}>Start processing</button>}
      <button type="button" className="site-link" onClick={() => void uploads.cancel(batch.key)}>Close</button>
    </div>
  </div>;
}
