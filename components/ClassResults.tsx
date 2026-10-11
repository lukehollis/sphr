"use client";

import { useState } from "react";
import { accountRequest } from "./AccountAuth";
import { accountNav, legalLinks } from "./AccountDashboard";
import SiteHeader from "./site/SiteHeader";
import { SiteFooter } from "./site/Chrome";
import type { AccountView } from "@/lib/server/customer-spaces";

type Row = { id: string; name: string; started: string; progress: string; finished: boolean; time: string };

/**
 * A tour's class results for its owner: who played and how far each got. Without a plan the
 * first players show and the rest are counted, with a way to choose a plan; with one, all of
 * them show and download as a spreadsheet. The owner can stop asking for names, and delete them.
 */
export default function ClassResults({ brand, account, tour, asking: initiallyAsking, players, finished, rows, hidden, all, paid }: {
  brand: string; account: AccountView; tour: { id: string; title: string; kind: "tour" | "hunt"; public: boolean; path: string };
  asking: boolean; players: number; finished: number; rows: Row[]; hidden: number; all: boolean; paid: boolean;
}) {
  const [asking, setAsking] = useState(initiallyAsking);
  const [list, setList] = useState(rows);
  const [counts, setCounts] = useState({ players, finished, hidden });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(paid ? "You're all set. Every player shows now." : "");
  const hunt = tour.kind === "hunt";

  async function run(work: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  const toggle = () => run(async () => {
    const result = await accountRequest(`/api/account/tours/${tour.id}/results`, { asking: !asking }, "PATCH");
    setAsking(result.asking);
    setMessage(result.asking ? "Players are asked for their name again." : "Players aren't asked for their name any more.");
  });
  const clear = () => {
    if (!window.confirm(`Delete the results of all ${counts.players} players? This can't be undone.`)) return;
    void run(async () => {
      await accountRequest(`/api/account/tours/${tour.id}/results`, {}, "DELETE");
      setList([]);
      setCounts({ players: 0, finished: 0, hidden: 0 });
      setMessage("The results are deleted.");
    });
  };

  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={accountNav(account, "spaces")} account={account.email} signOut="account" />
    <main className="site-main">
      <a className="site-back" href={`/account/tours/${tour.id}`}>← Back to the {hunt ? "hunt" : "tour"}</a>
      <div className="site-title">
        <div><h1>Class results</h1></div>
        <p>{tour.title}</p>
      </div>
      <p className="plan-lead">
        {counts.players === 0 ? (tour.public ? `No one has played it yet. Share the ${hunt ? "hunt" : "tour"}'s link with your class, and each player shows here.`
          : `Only you can open it for now. Choose Anyone with the link in the builder and share the link with your class, and each player shows here.`)
          : `${counts.players} ${counts.players === 1 ? "player" : "players"}, ${counts.finished} finished.`}
      </p>
      <div className="site-feedback" aria-live="polite">
        {message && <p className="site-note" role="status">{message}</p>}
        {error && <p className="site-alert" role="alert">{error}</p>}
      </div>

      {list.length > 0 && <div className="analytics-scroll"><table className="site-table">
        <thead><tr><th scope="col">Name</th><th scope="col">Started</th><th scope="col">{hunt ? "Finds" : "Stops"}</th><th scope="col">Finished</th><th scope="col">Time</th></tr></thead>
        <tbody>{list.map(row => <tr key={row.id}>
          <th scope="row">{row.name || "No name"}</th>
          <td suppressHydrationWarning>{new Date(row.started).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
          <td>{row.progress}</td>
          <td>{row.finished ? "Yes" : "Not yet"}</td>
          <td>{row.time}</td>
        </tr>)}</tbody>
      </table></div>}

      {counts.hidden > 0 && <div className="results-more">
        <p><strong>{counts.hidden} more {counts.hidden === 1 ? "player" : "players"}.</strong> Without a plan you see the first {list.length}. Every plan shows all your players and lets you download them.</p>
        <a className="site-button site-button-accent" href={`/account/plan?results=${tour.id}`}>Choose a plan<span aria-hidden="true">→</span></a>
      </div>}

      <div className="site-actions results-actions">
        {all && list.length > 0 && <a className="site-button" href={`/api/account/tours/${tour.id}/results.csv`}>Download as a spreadsheet</a>}
        <a className="site-button site-button-secondary" href={tour.path} target="_blank" rel="noreferrer">Open the {hunt ? "hunt" : "tour"} ↗</a>
      </div>

      <section className="results-settings" aria-labelledby="results-settings-title">
        <h2 id="results-settings-title">Names</h2>
        <p>{asking ? `Players type a name before they start, or play without one. We keep how far each one gets for a year, for you only.`
          : `Players aren't asked for a name, and nothing new is kept.`}</p>
        <div className="site-actions">
          <button type="button" className="site-button site-button-secondary" disabled={busy} onClick={toggle}>{asking ? "Stop asking for names" : "Ask for names again"}</button>
          {counts.players > 0 && <button type="button" className="site-link" disabled={busy} onClick={clear}>Delete these results</button>}
        </div>
      </section>
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
  </div></div>;
}
