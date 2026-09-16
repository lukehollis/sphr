"use client";

import { useMemo, useState } from "react";
import type { SceneListing } from "@/lib/scene-types";
import ShareLink from "@/components/ShareLink";

function SceneThumbnail({ scene }: { scene: SceneListing }) {
  const [failed, setFailed] = useState(false);
  return <div className="scene-thumbnail">
    {!failed ? <img src={scene.thumbnail} alt="" loading="lazy" decoding="async" width={960} height={640} onError={() => setFailed(true)} />
      : <span className="thumbnail-fallback">{scene.title.slice(0, 1)}</span>}
    <span className="thumbnail-badge">360° space</span>
    <span className="thumbnail-enter" aria-hidden="true">↗</span>
  </div>;
}

export default function SceneLibrary({ scenes }: { scenes: SceneListing[] }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const filtered = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return scenes.filter(scene => terms.every(term => `${scene.title} ${scene.sceneId} ${scene.titleSlug}`.toLocaleLowerCase().includes(term)))
      .sort((a, b) => sort === "title" ? a.title.localeCompare(b.title)
        : sort === "locations" ? b.nodeCount - a.nodeCount || a.title.localeCompare(b.title)
        : b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title));
  }, [scenes, query, sort]);

  return <main className="space-library" aria-label="Spaces">
    <div className="library-shell">
      <header className="library-header">
        <a href="/" className="collection-home">Spaces</a>
        <span className="collection-count"><strong>{scenes.length.toLocaleString()}</strong> {scenes.length === 1 ? "space" : "spaces"} in the collection</span>
      </header>
      <div className="library-layout">
        <aside className="library-toolbar" aria-label="Filter collection">
          <p className="library-section-label">Collection</p>
          <label className="library-search-label" htmlFor="space-search">Search spaces</label>
          <div className="library-search"><input id="space-search" type="search" placeholder="Title or scene ID" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="Clear search" onClick={() => setQuery("")}>Clear</button>}</div>
          <label className="library-sort" htmlFor="space-sort">Sort by</label>
          <select id="space-sort" className="library-sort-select" value={sort} onChange={event => setSort(event.target.value)} aria-label="Sort spaces"><option value="recent">Recently added</option><option value="title">Title A–Z</option><option value="locations">Most locations</option></select>
          <p className="library-note">Open a space to explore.<br />Copy its link to share.</p>
        </aside>
        <div className="library-exhibit">
          <p className="library-results" role="status">{query ? `${filtered.length} of ${scenes.length} spaces` : `All ${scenes.length} spaces`}</p>
          <section className="space-grid" aria-label="Available spaces">
            {filtered.map(scene => <article className="space-card" key={scene.sceneId}>
              <a className="space-card-link" href={scene.scenePath} aria-label={`Explore ${scene.title}`}>
                <SceneThumbnail scene={scene} />
                <div className="space-card-copy"><h2>{scene.title}</h2><p>{scene.nodeCount.toLocaleString()} {scene.nodeCount === 1 ? "location" : "locations"}<span aria-hidden="true"> · </span>Free explore</p></div>
              </a>
              <footer className="space-card-footer"><span>#{scene.sceneId}</span><ShareLink path={scene.scenePath} title={scene.title} /></footer>
            </article>)}
          </section>
          {!filtered.length && <section className="library-empty"><h2>{scenes.length ? "No spaces found" : "Your collection starts here"}</h2><p>{scenes.length ? "Try a different title or scene ID." : "Imported spaces will appear here with a preview and a link to share."}</p>{query && <button className="share-link-button" onClick={() => setQuery("")}>Clear search</button>}</section>}
        </div>
      </div>
      <footer className="library-footer"><span>Every space has a permanent link.</span><a href="/?demo=garden">Explore the 3DGS demo <span aria-hidden="true">↗</span></a></footer>
    </div>
  </main>;
}
