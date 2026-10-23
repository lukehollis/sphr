"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { accountRequest } from "./AccountAuth";
import { track } from "./Analytics";
import { accountNav, legalLinks } from "./AccountDashboard";
import SiteHeader from "./site/SiteHeader";
import { SectionHeader, SiteFooter, StatusMark } from "./site/Chrome";
import { getJson } from "./uploads";
import { readMatterportList } from "@/lib/matterport-link";
import type { AccountView } from "@/lib/server/customer-spaces";
import type { ImportSummary, ImportView } from "@/lib/server/imports";

/*
 * Bringing over many Matterport spaces at once: a page that takes a pasted list of links or a CSV file of them,
 * and a page per list that follows every space as it comes over (lib/server/imports.ts holds the queue).
 */

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
// Server and browser render the same text: times are given in UTC.
const when = (iso: string) => `${new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`;
const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** The form: links pasted or read from a CSV file, counted as they are typed, and the owner's permission once for all of them. */
export function ImportStart({ brand, account, imports, maxLinks, daily, hint }: { brand: string; account: AccountView; imports: ImportSummary[]; maxLinks: number;
  daily: number; hint?: string }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState("");
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const list = useMemo(() => readMatterportList(text), [text]);
  const count = list.links.length;
  const tooMany = count > maxLinks;

  async function choose(files: FileList | null) {
    const chosen = files?.[0];
    if (!chosen) return;
    if (chosen.size > 2e6) { setError("That file is larger than a list of links would be. Choose a CSV or text file that lists your Matterport links."); return; }
    const content = await chosen.text();
    setText(content); setFile(chosen.name); setError("");
    track("import_file_chosen", { links: readMatterportList(content).links.length });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const result = await accountRequest("/api/account/imports", { links: list.links, permission: true });
      track("import_started", { links: count });
      window.location.assign(`/account/import/${result.import.id}`);
    } catch (failure) {
      track("import_refused", { message: (failure as Error).message.slice(0, 120) });
      setError((failure as Error).message);
      setBusy(false);
    }
  }

  const found = !text.trim() ? "" : [count ? `${plural(count, "Matterport space")} found.` : "No Matterport links found yet.",
    list.repeated ? `${plural(list.repeated, "link")} listed twice, kept once.` : "",
    list.unreadable ? `${plural(list.unreadable, "line")} without a Matterport link left out.` : "",
    tooMany ? `A list brings over up to ${maxLinks} spaces, so split this one.` : ""].filter(Boolean).join(" ");

  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={accountNav(account, "space")} account={account.email} signOut="account" />
    <main className="site-main">
      <a className="site-back" href="/account">← Your spaces</a>
      <div className="site-title"><div><h1>Bring over your Matterport spaces</h1></div></div>
      <form className="import-form" onSubmit={submit}>
        <p className="import-lead">Paste the links to your Matterport spaces, one per line, or choose a CSV file that lists them. Each space comes over as a tour of its 360 photos, with where each was taken, the dollhouse and its tags. No E57 needed.</p>
        <div className="site-field">
          <div className="site-field-label"><label htmlFor="import-links">Links</label>
            <button type="button" className="site-link" onClick={() => picker.current?.click()}>{file ? `From ${file}. Choose another file` : "Choose a CSV file"}</button></div>
          <textarea id="import-links" className="site-input import-links" rows={10} spellCheck={false} autoComplete="off" value={text}
            placeholder={"https://my.matterport.com/show/?m=…\nhttps://my.matterport.com/show/?m=…"} onChange={event => { setText(event.target.value); setFile(""); }} />
          <input ref={picker} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden onChange={event => { void choose(event.target.files); event.target.value = ""; }} />
          <p className="site-hint" role="status" aria-live="polite">{found || "A CSV file can have the links in any column. A column named title or name gives each space its title, and otherwise each keeps its name from Matterport."}</p>
        </div>
        <label className="site-check"><input type="checkbox" checked={allowed} onChange={event => setAllowed(event.target.checked)} />
          I own these spaces or have their owners&apos; permission</label>
        <p className="site-hint">They come over one at a time, up to {daily} a day, so a long list takes a few days. Each appears in your spaces as it is ready, and one page follows them all.{hint ? ` ${hint}` : ""}</p>
        {error && <p className="site-alert" role="alert">{error}</p>}
        <div className="site-actions">
          <button type="submit" className="site-button site-button-accent" disabled={busy || !allowed || !count || tooMany}>
            {busy ? "Checking the links…" : count ? `Bring over ${plural(count, "space")}` : "Bring them over"}<span aria-hidden="true">→</span></button>
        </div>
      </form>

      {imports.length > 0 && <section className="import-earlier">
        <SectionHeader title="Your lists" />
        <ul className="import-lists">
          {imports.map(item => <li key={item.id}>
            <a href={`/account/import/${item.id}`}><strong>{plural(item.total, "Matterport space")}</strong>
              <span>Added {dayOf(item.created)}</span>
              <span>{item.finished ? `${item.ready} ready${item.failed ? `, ${item.failed} need attention` : ""}`
                : `${item.ready} ready, ${item.working + item.waiting} on the way`}</span></a>
          </li>)}
        </ul>
      </section>}
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
  </div></div>;
}

type Item = ImportView["items"][number];

/** What one link is doing, in a few words. */
function itemLine(item: Item, view: ImportView) {
  const blocker = view.blocker;
  if (item.status === "checking") return "Checking the link with Matterport";
  if (item.status === "waiting") {
    if (item.space?.status === "unpaid") return "Waits for payment";
    if (blocker?.kind === "payment") return "Waits for hosting to start";
    if (blocker?.kind === "plan") return "Waits for room in your plan";
    if (blocker?.kind === "limit") return "Waits for room in your account";
    if (blocker?.kind === "billing") return "Waits a minute for billing";
    if (item.after) return `Starts after ${when(item.after)}`;
    return item.ahead ? `${plural(item.ahead, "space")} ahead of it` : "Next to come over";
  }
  if (item.status === "queued") return "In line for processing";
  if (item.status === "processing") return item.space?.progress ?? "Coming over now";
  if (item.status === "ready") return item.space?.preview ? "Ready as your free preview, private to you" : item.space?.public ? "Ready and public" : "Ready, private until you share it";
  if (item.status === "failed") return item.space?.message ?? "Needs attention";
  if (item.status === "refused") return item.reason ?? "Left out";
  if (item.status === "skipped") return "Taken off the list";
  return "Deleted from your spaces";
}

const marks: Record<string, [string, string]> = {
  checking: ["waiting", "Checking"], waiting: ["waiting", "Waiting"], queued: ["queued", "Submitted"], processing: ["processing", "Coming over"],
  ready: ["ready", "Ready"], failed: ["failed", "Needs attention"], refused: ["offline", "Left out"], skipped: ["offline", "Taken off"], deleted: ["offline", "Deleted"]
};

/** What holds the list back, and the one thing to do about it when there is one. */
function Holdup({ view }: { view: ImportView }) {
  const blocker = view.blocker;
  const waiting = view.counts.waiting;
  const preview = view.items.find(item => item.space?.preview && item.status !== "waiting");
  const plan = `/account/plan?import=${view.id}`;
  if (!waiting || view.finished) return null;
  if (blocker?.kind === "payment") return <div className="site-callout site-callout-action" role="status">
    <p>{preview ? `Your free preview of ${preview.title} comes over first. Start hosting to bring over the other ${plural(waiting, "space")}.`
      : `Start hosting to bring over ${waiting === 1 ? "this space" : `these ${waiting} spaces`}. They come over as soon as payment goes through.`}</p>
    <a className="site-button site-button-accent" href={plan}>Start hosting<span aria-hidden="true">→</span></a>
  </div>;
  if (blocker?.kind === "plan") return <div className="site-callout site-callout-action" role="status">
    <p>Your plan covers {plural(blocker.spaces, "space")} and all of them are in use. Change plans to bring over the other {plural(waiting, "space")}.</p>
    <a className="site-button site-button-accent" href={plan}>Change plan<span aria-hidden="true">→</span></a>
  </div>;
  if (blocker?.kind === "limit") return <p className="site-alert" role="status">{blocker.message}</p>;
  if (blocker?.kind === "billing") return <p className="site-note" role="status">Billing could not be updated, so the next space waits. We try again every minute.</p>;
  if (blocker?.kind === "daily") return <p className="site-note" role="status">
    Up to {view.daily} spaces start each day, so the next one starts after {blocker.until ? when(blocker.until) : "a day"}. The rest keep their place, and you can close this page.</p>;
  return <p className="site-note" role="status">Spaces come over one at a time, up to {view.daily} a day. You can close this page, and we will email you once all of them are here.</p>;
}

/** One list: every link with what it became or what it waits for, updated every few seconds until the list is done. */
export function ImportProgress({ brand, account, initial, notice }: { brand: string; account: AccountView; initial: ImportView; notice?: string }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const done = Boolean(view.finished);
  useEffect(() => {
    if (done) return;
    const timer = setInterval(async () => {
      const result = await getJson(`/api/account/imports/${view.id}`).catch(() => undefined);
      if (result?.import) setView(result.import);
    }, 5000);
    return () => clearInterval(timer);
  }, [done, view.id]);

  async function act(key: string, body: object) {
    setBusy(key); setError("");
    try { setView((await accountRequest(`/api/account/imports/${view.id}`, body)).import); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(""); }
  }
  function stop() {
    if (!window.confirm(`Take the ${plural(view.counts.waiting, "space")} still waiting off this list? Spaces already made stay.`)) return;
    track("import_stopped", { waiting: view.counts.waiting });
    void act("stop", { action: "stop" });
  }

  const { counts } = view;
  const coming = counts.total - counts.refused - counts.skipped;
  const settled = counts.ready + counts.failed + counts.deleted;
  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={accountNav(account, "space")} account={account.email} signOut="account" />
    <main className="site-main">
      <a className="site-back" href="/account">← Your spaces</a>
      <div className="site-title">
        <div><h1>{done ? "Your Matterport spaces are here" : `Bringing over ${plural(coming, "Matterport space")}`}</h1></div>
        <p>Added {dayOf(view.created)}</p>
      </div>
      <div className="site-feedback" aria-live="polite">
        {notice && <p className="site-note" role="status">{notice}</p>}
        {error && <p className="site-alert" role="alert">{error}</p>}
      </div>
      <Holdup view={view} />
      <dl className="site-stats">
        <div><dt>Ready</dt><dd>{counts.ready}</dd></div>
        <div><dt>Coming over</dt><dd>{counts.working}</dd></div>
        <div><dt>Waiting</dt><dd>{counts.waiting}</dd></div>
        <div><dt>Need attention</dt><dd>{counts.failed}</dd></div>
        {counts.refused + counts.skipped > 0 && <div><dt>Left out</dt><dd>{counts.refused + counts.skipped}</dd></div>}
      </dl>
      {coming > 0 && <span className="upload-meter import-meter" role="progressbar" aria-label="Spaces brought over" aria-valuemin={0} aria-valuemax={coming} aria-valuenow={settled}>
        <span style={{ width: `${Math.round(settled / coming * 100)}%` }} /></span>}

      <ul className="import-items" aria-label="Matterport spaces">
        {view.items.map(item => {
          const [mark, label] = marks[item.status] ?? ["offline", item.status];
          return <li key={item.id} className={`import-item import-item-${item.status}`}>
            <span className="import-item-name">
              {item.space ? <a href={`/account/spaces/${item.space.id}`}>{item.title}</a> : <strong>{item.title}</strong>}
              <small>{item.url}{item.sweeps ? `, ${plural(item.sweeps, "scan point")}` : ""}</small>
            </span>
            <StatusMark status={mark} label={label} />
            <span className="import-item-line">{itemLine(item, view)}</span>
            <span className="import-item-actions">
              {item.space?.path && <a className="site-link" href={item.space.path}>Open</a>}
              {(item.status === "checking" || (item.status === "waiting" && !item.space)) && <button type="button" className="site-link" disabled={Boolean(busy)}
                onClick={() => void act(item.id, { action: "skip", item: item.id })}>{busy === item.id ? "Taking off…" : "Take off the list"}</button>}
            </span>
          </li>;
        })}
      </ul>
      <div className="site-actions import-actions">
        <a className="site-button site-button-secondary" href="/account/import">Add another list</a>
        {counts.waiting > 0 && !done && <button type="button" className="site-link" disabled={Boolean(busy)} onClick={stop}>{busy === "stop" ? "Stopping…" : "Stop the rest"}</button>}
      </div>
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
  </div></div>;
}
