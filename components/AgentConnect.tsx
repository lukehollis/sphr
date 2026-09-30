"use client";

import { useState } from "react";
import AuthShell from "./site/AuthShell";
import { accountRequest } from "./AccountAuth";

type Link = { code: string; client: string; approved: boolean };

/** Approves an agent's code so it can add spaces and upload files for this account. */
export default function AgentConnect({ brand, email, link }: { brand: string; email: string; link: Link | null }) {
  const [state, setState] = useState<"ask" | "linked" | "declined">(link?.approved ? "linked" : "ask");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function answer(approve: boolean) {
    if (!link) return;
    setBusy(true); setError("");
    try { await accountRequest("/api/account/agents", { code: link.code, approve }); setState(approve ? "linked" : "declined"); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  const client = link?.client ?? "Your agent";
  const heading = !link ? "This code has expired" : state === "linked" ? `${client} is linked` : state === "declined" ? "Link cancelled"
    : `Link ${client} to your account`;
  const lede = !link ? "Ask your agent to start again and it will open a new link."
    : state === "linked" ? `You can close this tab and go back to ${client}.`
    : state === "declined" ? `${client} was not linked. You can close this tab.`
    : `${client} will be able to add spaces and upload files to ${email}.`;
  return <AuthShell brand={brand} headline="Host 3D captures as virtual spaces.">
    <div className="site-auth-form">
      <div className="site-auth-heading"><span className="site-code">A.6</span><h2>{heading}</h2><p>{lede}</p></div>
      {link && state === "ask" && <>
        <div className="site-agent-code">
          <span>Code</span>
          <strong>{link.code}</strong>
          <p>Only link it if your agent shows this same code.</p>
        </div>
        {error && <p className="site-alert" role="alert">{error}</p>}
        <button type="button" className="site-button site-button-accent site-button-block" disabled={busy} onClick={() => answer(true)}>
          {busy ? "Linking…" : "Link agent"}<span aria-hidden="true">→</span></button>
        <p className="site-auth-switch"><button type="button" className="site-link-button" disabled={busy} onClick={() => answer(false)}>Cancel</button></p>
      </>}
      {(!link || state !== "ask") && <p className="site-auth-switch"><a href="/account">Go to your spaces</a></p>}
    </div>
  </AuthShell>;
}
