"use client";

import { useMemo, useState } from "react";
import type { SceneListing } from "@/lib/scene-types";

const isGuided = (scene: SceneListing) => scene.hasGuidedTour ?? scene.legacy?.kind === "tour";

function SceneThumbnail({ scene }: { scene: SceneListing }) {
  const [failed, setFailed] = useState(false);
  return <div className="scene-thumbnail">
    {!failed ? <img src={scene.thumbnail} alt="" loading="lazy" decoding="async" width={960} height={640} onError={() => setFailed(true)} />
      : <span className="thumbnail-fallback">{scene.title.slice(0, 1)}</span>}
  </div>;
}

export default function SceneLibrary({ scenes, showAdminLink = false }: { scenes: SceneListing[]; showAdminLink?: boolean }) {
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

  return <div className="space-library">
    <div className="library-shell library-shell-with-footer">
      <main className="library-layout" aria-label="Spaces">
        <aside className="library-toolbar" aria-label="Filter collection">
          <div className="library-kind" role="group" aria-label="Collection type">
            {[["all", "All"], ["guided", "Guided tours"], ["spaces", "Spaces"]].map(([value, label]) =>
              <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}
          </div>
          <label className="library-search-label" htmlFor="space-search">Search spaces</label>
          <div className="library-search"><input id="space-search" type="search" placeholder="Title or scene ID" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="Clear search" onClick={() => setQuery("")}>Clear</button>}</div>
          <label className="library-sort" htmlFor="space-sort">Sort by</label>
          <select id="space-sort" className="library-sort-select" value={sort} onChange={event => setSort(event.target.value)} aria-label="Sort spaces"><option value="recent">Recently added</option><option value="title">Title A–Z</option><option value="locations">Most locations</option></select>
        </aside>
        <div className="library-exhibit">
          <p className="sr-only" role="status">{filtered.length} {filtered.length === 1 ? "space" : "spaces"} found</p>
          <section className="space-grid" aria-label="Available spaces">
            {filtered.map(scene => <article className="space-card" key={scene.sceneId}>
              <a className="space-card-link" href={scene.scenePath} aria-label={`Explore ${scene.title}`}>
                <SceneThumbnail scene={scene} />
                <div className="space-card-copy">{isGuided(scene) && <span className="space-card-kind">Guided tour</span>}<h2>{scene.title}</h2></div>
              </a>
            </article>)}
          </section>
          {!filtered.length && <section className="library-empty"><p>{scenes.length ? "No spaces found." : "No public spaces."}</p>{query && <button className="share-link-button" onClick={() => setQuery("")}>Clear search</button>}</section>}
        </div>
      </main>
      {showAdminLink && <footer className="library-footer">
        <nav aria-label="Account"><a href="/admin">Manage spaces</a></nav>
      </footer>}
    </div>
  </div>;
}
