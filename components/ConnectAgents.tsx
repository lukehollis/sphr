"use client";

import { useState } from "react";
import { SectionHeader } from "./site/Chrome";
import { agentClients, tourAsk, type AgentWay } from "@/lib/agents";

function CopyLine({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Older browsers and some embedded views have no clipboard API.
      const area = document.createElement("textarea");
      area.value = value;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy"); } catch { /* nothing more to try */ }
      area.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }
  return (
    <div className="connect-copy">
      <code className="connect-code">{value}</code>
      <button type="button" className="site-button site-button-secondary connect-copy-button" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Way({ way }: { way: AgentWay }) {
  return (
    <div className="connect-way">
      <div className="connect-way-label">{way.label}</div>
      <p className="connect-way-text">{way.text}</p>
      {way.download && <a className="site-button site-button-secondary connect-download" href={way.download.href} download>{way.download.label}</a>}
      {way.copy && <CopyLine value={way.copy} label={way.label} />}
    </div>
  );
}

/** A compact version of the homepage's agent band, so a signed-in customer can point their own agent at this account. */
export default function ConnectAgents() {
  const [selected, setSelected] = useState(agentClients[0].id);
  const current = agentClients.find(client => client.id === selected) ?? agentClients[0];
  return (
    <section className="connect" aria-labelledby="connect-title">
      <SectionHeader title={<span id="connect-title">Connect an agent</span>} code="0.1" />
      <p className="connect-lead">Let your own AI agent publish captures straight to this account and build tours and scavenger hunts in them. Pick your agent, add Spacery once, then ask.</p>
      <div className="connect-tabs" role="tablist" aria-label="Your agent">
        {agentClients.map(client => (
          <button key={client.id} type="button" role="tab" aria-selected={client.id === selected} className="connect-tab"
            onClick={() => setSelected(client.id)}>{client.name}</button>
        ))}
      </div>
      <div className="connect-panel" role="tabpanel">
        <div className="connect-ways">{current.ways.map(way => <Way key={way.label} way={way} />)}</div>
        <p className="connect-ask"><span>Then ask</span>{`“${current.ask}”`}</p>
        <p className="connect-ask"><span>Or ask</span>{`“${tourAsk}”`}</p>
      </div>
    </section>
  );
}
