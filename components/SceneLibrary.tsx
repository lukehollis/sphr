"use client";

import { useMemo, useState } from "react";
import type { SceneListing } from "@/lib/scene-types";
import SiteHeader from "./site/SiteHeader";
import { SiteFooter } from "./site/Chrome";

const isGuided = (scene: SceneListing) => scene.hasGuidedTour ?? scene.legacy?.kind === "tour";

function SceneThumbnail({ scene }: { scene: SceneListing }) {
  const [failed, setFailed] = useState(false);
  return <div className="site-card-media">
    {!failed ? <img src={scene.thumbnail} alt="" loading="lazy" decoding="async" width={960} height={640} onError={() => setFailed(true)} />
      : <span className="site-card-letter" aria-hidden="true">{scene.title.slice(0, 1)}</span>}
    {isGuided(scene) && <span className="site-card-tag site-card-kind">Guided tour</span>}
  </div>;
}

export default function SceneLibrary({ scenes, showAdminLink = false, brand }: { scenes: SceneListing[]; showAdminLink?: boolean; brand: string }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [kind, setKind] = useState("all");
  const filtered = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return scenes.filter(scene => (kind === "all" || isGuided(scene) === (kind === "guided"))
      && terms.every(term => `${scene.title} ${scene.sceneId} ${scene.titleSlug}`.toLocaleLowerCase().includes(term)))
      .sort((a, b) => sort === "title" ? a.title.localeCompare(b.title)
        : sort === "locations" ? b.nodeCount - a.nodeCount || a.title.localeCompare(b.title)
        : b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title));
  }, [scenes, query, sort, kind]);

  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} home="/" nav={showAdminLink ? [{ href: "/", label: "Collection", current: true }, { href: "/admin", label: "Manage spaces" }] : []}
      signOut={showAdminLink ? "admin" : undefined} />
    <main className="site-main" aria-label="Spaces">
      <h1 className="sr-only">Spaces</h1>
      <div className="site-toolbar" role="search" aria-label="Filter collection">
        <div className="site-segmented site-kind" role="group" aria-label="Collection type">
          {[["all", "All"], ["guided", "Guided tours"], ["spaces", "Spaces"]].map(([value, label]) =>
            <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}
        </div>
        <div className="site-field site-search">
          <label htmlFor="space-search">Search spaces</label>
          <div className="site-search-box">
            <input className="site-input" id="space-search" type="search" placeholder="Title or scene ID" value={query} onChange={event => setQuery(event.target.value)} />
            {query && <button type="button" className="site-link" aria-label="Clear search" onClick={() => setQuery("")}>Clear</button>}
          </div>
        </div>
        <div className="site-field site-sort">
          <label htmlFor="space-sort">Sort by</label>
          <select id="space-sort" className="site-input site-select" value={sort} onChange={event => setSort(event.target.value)}>
            <option value="recent">Recently added</option><option value="title">Title A–Z</option><option value="locations">Most locations</option>
          </select>
        </div>
      </div>
      <p className="sr-only" role="status">{filtered.length} {filtered.length === 1 ? "space" : "spaces"} found</p>
      <section className="site-grid" aria-label="Available spaces">
        {filtered.map(scene => <a className="site-card" key={scene.sceneId} href={scene.scenePath} aria-label={`Explore ${scene.title}`}>
          <SceneThumbnail scene={scene} />
          <div className="site-card-body"><h3>{scene.title}</h3></div>
        </a>)}
      </section>
      {!filtered.length && <div className="site-callout site-callout-action">
        <p>{scenes.length ? "No spaces found." : "No public spaces."}</p>
        {query && <button type="button" className="site-button site-button-secondary" onClick={() => setQuery("")}>Clear search</button>}
      </div>}
    </main>
    <SiteFooter brand={<>© {new Date().getFullYear()} <a href="https://mused.com/">mused.com</a></>} />
  </div></div>;
}
