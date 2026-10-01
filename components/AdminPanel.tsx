"use client";

import { useState, type FormEvent } from "react";
import type { SceneListing } from "@/lib/scene-types";
import AuthShell from "./site/AuthShell";
import SiteHeader from "./site/SiteHeader";
import { SectionHeader, SiteFooter, StatusMark } from "./site/Chrome";

type ManagedScene = SceneListing & { public: boolean };

async function request(url: string, body?: object, method = "POST") {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to save. Try again.");
  return data;
}

export function AdminLogin({ returnPath = "/admin", brand }: { returnPath?: string; brand: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      await request("/api/admin/login", { username: form.get("username"), password: form.get("password") });
      window.location.assign(returnPath);
    } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  return <AuthShell brand={brand} home="/" headline="Manage the collection.">
    <form className="site-auth-form site-form" onSubmit={submit}>
      <div className="site-auth-heading"><span className="site-code">M.1</span><h2>Admin sign in</h2><p>For the people who run this site.</p></div>
      <div className="site-field"><label htmlFor="username">Username</label><input className="site-input" id="username" name="username" autoComplete="username" required maxLength={64} /></div>
      <div className="site-field"><label htmlFor="password">Password</label><input className="site-input" id="password" name="password" type="password" autoComplete="current-password" required maxLength={256} /></div>
      {error && <p className="site-alert" role="alert">{error}</p>}
      <button className="site-button site-button-block" disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in"}<span aria-hidden="true">→</span></button>
    </form>
  </AuthShell>;
}

export default function AdminPanel({ scenes: initial, brand }: { scenes: ManagedScene[]; brand: string }) {
  const [scenes, setScenes] = useState(initial);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function visibility(scene: ManagedScene, value: boolean) {
    if (scene.public === value) return;
    setBusy(scene.sceneId); setError(""); setMessage("");
    try {
      await request(`/api/admin/scenes/${scene.sceneId}`, { public: value }, "PATCH");
      setScenes(items => items.map(item => item.sceneId === scene.sceneId ? { ...item, public: value } : item));
      setMessage(`${scene.title} is now ${value ? "public" : "private"}.`);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(null); }
  }
  async function password(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    setError(""); setMessage("");
    if (form.get("replacement") !== form.get("confirm")) { setError("New passwords do not match."); return; }
    setBusy("password");
    try {
      await request("/api/admin/password", { current: form.get("current"), replacement: form.get("replacement") });
      element.reset(); setMessage("Password changed. Other sessions have been signed out.");
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(null); }
  }
  const filtered = scenes.filter(scene => `${scene.title} ${scene.sceneId}`.toLowerCase().includes(query.toLowerCase().trim()));
  const shared = scenes.filter(scene => scene.public).length;
  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} home="/" nav={[{ href: "/", label: "Collection" }, { href: "/admin", label: "Manage", current: true }, { href: "/admin/analytics", label: "Analytics" }]} signOut="admin" />
    <main className="site-main">
      <div className="site-title">
        <div><span className="site-code">M</span><h1>Manage spaces</h1></div>
        <p>Private spaces open only while you’re signed in. Public spaces open for anyone with the link.</p>
      </div>
      <dl className="site-stats">
        <div><dt>Spaces</dt><dd>{scenes.length}</dd></div>
        <div><dt>Public</dt><dd>{shared}</dd></div>
        <div><dt>Private</dt><dd>{scenes.length - shared}</dd></div>
      </dl>
      <div className="site-feedback" aria-live="polite">
        {message && <p className="site-note" role="status">{message}</p>}
        {error && <p className="site-alert" role="alert">{error}</p>}
      </div>

      <section className="site-block" aria-labelledby="managed-spaces">
        <SectionHeader title={<span id="managed-spaces">Spaces</span>} code="1.0">{filtered.length !== scenes.length && <span className="site-count">{filtered.length} of {scenes.length}</span>}</SectionHeader>
        <div className="site-toolbar">
          <div className="site-field site-search">
            <label htmlFor="admin-search">Search spaces</label>
            <input className="site-input" id="admin-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Title or scene ID" />
          </div>
        </div>
        {filtered.length ? <div className="site-grid">{filtered.map(scene => <article className="site-card site-card-managed" key={scene.sceneId}>
          <a className="site-card-link" href={scene.scenePath} aria-label={`Open ${scene.title}`}>
            <div className="site-card-media">
              <img src={scene.thumbnail} alt="" loading="lazy" width={960} height={640} />
              <span className="site-card-tag"><StatusMark status={scene.public ? "public" : "private"} /></span>
            </div>
            <div className="site-card-body"><h3>{scene.title}</h3><p>{scene.sceneId}</p></div>
          </a>
          <div className="site-card-controls">
            <div className="site-segmented" role="radiogroup" aria-label={`Visibility for ${scene.title}`}>
              {([[false, "Private"], [true, "Public"]] as const).map(([value, label]) =>
                <button key={label} type="button" role="radio" aria-checked={scene.public === value} disabled={Boolean(busy)} onClick={() => visibility(scene, value)}>{label}</button>)}
            </div>
            <a className="site-link" href={`/admin/scenes/${scene.sceneId}`}>Edit space</a>
          </div>
        </article>)}</div> : <p className="site-note">No spaces found.</p>}
      </section>

      <section className="site-block" aria-labelledby="admin-password">
        <SectionHeader title={<span id="admin-password">Password</span>} code="2.0" />
        <form className="site-form site-password" onSubmit={password}>
          <div className="site-field"><label htmlFor="current-password">Current password</label><input className="site-input" id="current-password" name="current" type="password" autoComplete="current-password" required maxLength={256} /></div>
          <div className="site-field"><label htmlFor="new-password">New password</label><input className="site-input" id="new-password" name="replacement" type="password" autoComplete="new-password" minLength={8} maxLength={256} required /></div>
          <div className="site-field"><label htmlFor="confirm-password">Confirm password</label><input className="site-input" id="confirm-password" name="confirm" type="password" autoComplete="new-password" minLength={8} maxLength={256} required /></div>
          <div><button className="site-button site-button-secondary" type="submit" disabled={Boolean(busy)}>{busy === "password" ? "Saving…" : "Save password"}</button></div>
        </form>
        <p className="site-hint">Saving signs out every other admin session.</p>
      </section>
    </main>
    <SiteFooter brand={brand} />
  </div></div>;
}
