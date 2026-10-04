"use client";

import { useMemo, useState } from "react";
import { accountRequest } from "./AccountAuth";
import { accountNav, legalLinks } from "./AccountDashboard";
import SiteHeader from "./site/SiteHeader";
import { SectionHeader, SiteFooter } from "./site/Chrome";
import type { AccountView } from "@/lib/server/customer-spaces";
import type { PickerSpace } from "@/lib/server/user-tours";

type Kind = "tour" | "hunt";

function describe(space: PickerSpace) {
  return space.nodeCount > 1 ? `${space.nodeCount} places to stand` : space.nodeCount === 1 ? "One 360 view" : "3D capture";
}

function SpaceChoice({ space, busy, onChoose }: { space: PickerSpace; busy: string | null; onChoose: (sceneId: string) => void }) {
  const [failed, setFailed] = useState(false);
  const opening = busy === space.sceneId;
  return <button type="button" className="site-card tour-pick" disabled={busy !== null} aria-busy={opening} onClick={() => onChoose(space.sceneId)}>
    <span className="site-card-media">
      {!failed ? <img src={space.thumbnail} alt="" loading="lazy" decoding="async" width={960} height={640} onError={() => setFailed(true)} />
        : <span className="site-card-letter" aria-hidden="true">{space.title.slice(0, 1)}</span>}
      {opening && <span className="site-card-tag site-card-kind">Opening the builder</span>}
    </span>
    <span className="site-card-body"><span className="tour-pick-title">{space.title}</span><span className="tour-pick-meta">{describe(space)}</span></span>
  </button>;
}

/** Choose what to make and the space to build it on: one of the customer's own, or one of Spacery's. */
export default function TourSpacePicker({ brand, account, own, spacery, chosen, kind: initialKind, paid = false, agentsUrl }:
  { brand: string; account: AccountView; own: PickerSpace[]; spacery: PickerSpace[]; chosen: PickerSpace | null; kind: Kind;
    /** Back from choosing a plan. */ paid?: boolean; /** Where customers learn to connect their own agents. */ agentsUrl?: string }) {
  const [kind, setKind] = useState<Kind>(initialKind);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const chosenSpace = chosen;
  const filtered = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return spacery.filter(space => terms.every(term => space.title.toLocaleLowerCase().includes(term)));
  }, [spacery, query]);

  async function create(sceneId: string, as: Kind = kind) {
    setBusy(sceneId); setError("");
    try {
      const { tour } = await accountRequest("/api/account/tours", { sceneId, kind: as });
      window.location.assign(tour.editor);
    } catch (failure) { setError((failure as Error).message); setBusy(null); }
  }

  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={accountNav(account, "spaces")} account={account.email} signOut="account" />
    <main className="site-main">
      <div className="spaces-head">
        <div>
          <h1>Make a tour or a scavenger hunt</h1>
          <p>Choose a space to build on. Use one of your own or any of ours, and only you can open it until you share its link.</p>
        </div>
      </div>
      <div className="site-feedback" aria-live="polite">
        {paid && !error && <p className="site-note" role="status">You're all set. Tours and scavenger hunts are included in your plan.</p>}
        {error && <p className="site-alert" role="alert">{error}</p>}
      </div>
      {!account.emailVerified && <div className="site-callout"><p>Confirm your email address to make tours. We sent a link to <strong>{account.email}</strong>, and it may be in spam or junk.</p></div>}

      {chosenSpace && <section className="tour-chosen" aria-labelledby="chosen-title">
        <img src={chosenSpace.thumbnail} alt="" width={960} height={640} />
        <div>
          <h2 id="chosen-title">{chosenSpace.title}</h2>
          <p>Build a guided tour or a scavenger hunt on this space. Describe it in a few words and the builder drafts every stop for you to edit{agentsUrl
            ? <>, or let <a href={agentsUrl}>your own agent</a> build it</> : null}. The space itself stays as it is.</p>
          <div className="tour-chosen-actions">
            <button type="button" className="site-button site-button-accent" disabled={busy !== null} onClick={() => void create(chosenSpace.sceneId, "tour")}>Make a guided tour</button>
            <button type="button" className="site-button site-button-secondary" disabled={busy !== null} onClick={() => void create(chosenSpace.sceneId, "hunt")}>Make a scavenger hunt</button>
          </div>
        </div>
      </section>}

      <div className="site-toolbar tour-kind">
        <div className="site-field">
          <span className="site-field-label" id="tour-kind-label">What to make</span>
          <div className="site-segmented site-kind" role="radiogroup" aria-labelledby="tour-kind-label">
            <button type="button" role="radio" aria-checked={kind === "tour"} onClick={() => setKind("tour")}>Guided tour</button>
            <button type="button" role="radio" aria-checked={kind === "hunt"} onClick={() => setKind("hunt")}>Scavenger hunt</button>
          </div>
        </div>
        <p className="tour-kind-hint">{kind === "hunt" ? "Visitors look for things you hide, with clues, hints and a reward at the end."
          : "Visitors follow stops you write, with objects, effects and sound along the way."}</p>
      </div>

      <section className="tour-spaces" aria-labelledby="own-spaces">
        <SectionHeader title={<span id="own-spaces">Your spaces</span>} />
        {own.length ? <div className="site-grid">{own.map(space => <SpaceChoice key={space.sceneId} space={space} busy={busy} onChoose={id => void create(id)} />)}</div>
          : <p className="tour-none">Spaces you add show up here once they are ready. <a href="/account">Add a space</a></p>}
      </section>

      <section className="tour-spaces" aria-labelledby="spacery-spaces">
        <SectionHeader title={<span id="spacery-spaces">Spacery spaces</span>} />
        <div className="site-toolbar" role="search" aria-label="Search Spacery spaces">
          <div className="site-field site-search">
            <label htmlFor="tour-space-search">Search</label>
            <div className="site-search-box">
              <input className="site-input" id="tour-space-search" type="search" placeholder="Museum, temple, garden" value={query} onChange={event => setQuery(event.target.value)} />
              {query && <button type="button" className="site-link" aria-label="Clear search" onClick={() => setQuery("")}>Clear</button>}
            </div>
          </div>
        </div>
        <p className="sr-only" role="status">{filtered.length} {filtered.length === 1 ? "space" : "spaces"} found</p>
        <div className="site-grid">{filtered.map(space => <SpaceChoice key={space.sceneId} space={space} busy={busy} onChoose={id => void create(id)} />)}</div>
        {!filtered.length && <p className="tour-none">{spacery.length ? "No spaces match that search." : "No Spacery spaces are open for building yet."}</p>}
      </section>
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
  </div></div>;
}
