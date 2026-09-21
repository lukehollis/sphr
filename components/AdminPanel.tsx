"use client";

import { useState, type FormEvent } from "react";
import type { SceneListing } from "@/lib/scene-types";

type ManagedScene = SceneListing & { public: boolean };

async function request(url: string, body?: object, method = "POST") {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to save. Try again.");
  return data;
}

export function AdminLogin({ returnPath = "/admin" }: { returnPath?: string }) {
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
  return <main className="admin-login"><form className="admin-form" onSubmit={submit}>
    <h1>Admin sign in</h1>
    <label htmlFor="username">Username</label><input id="username" name="username" autoComplete="username" required maxLength={64} />
    <label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required maxLength={256} />
    {error && <p role="alert">{error}</p>}
    <button disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
    <a href="/">Back to collection</a>
  </form></main>;
}

export default function AdminPanel({ scenes: initial }: { scenes: ManagedScene[] }) {
  const [scenes, setScenes] = useState(initial);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function visibility(scene: ManagedScene, value: boolean) {
    setBusy(scene.sceneId); setError(""); setMessage("");
    try {
      await request(`/api/admin/scenes/${scene.sceneId}`, { public: value }, "PATCH");
      setScenes(items => items.map(item => item.sceneId === scene.sceneId ? { ...item, public: value } : item));
      setMessage(`${scene.title} is now ${value ? "public" : "private"}.`);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(null); }
  }
  async function logout() {
    try { await request("/api/admin/logout"); window.location.assign("/admin/login"); }
    catch (failure) { setError((failure as Error).message); }
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
  return <main className="space-library admin-library"><div className="library-shell">
    <header className="admin-header"><h1>Manage spaces</h1><nav aria-label="Admin"><a href="/">Public collection</a><button onClick={logout}>Sign out</button></nav></header>
    <div className="library-layout">
      <aside className="library-toolbar"><label className="library-search-label" htmlFor="admin-search">Search spaces</label><div className="library-search"><input id="admin-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Title or scene ID" /></div>
        <p className="admin-help">Private spaces are visible only when you’re signed in. Public spaces can be opened by anyone with the link.</p>
        <details className="admin-password"><summary>Change password</summary><form className="admin-form" onSubmit={password}>
          <label htmlFor="current-password">Current password</label><input id="current-password" name="current" type="password" autoComplete="current-password" required maxLength={256} />
          <label htmlFor="new-password">New password</label><input id="new-password" name="replacement" type="password" autoComplete="new-password" minLength={8} maxLength={256} required />
          <label htmlFor="confirm-password">Confirm password</label><input id="confirm-password" name="confirm" type="password" autoComplete="new-password" minLength={8} maxLength={256} required />
          <button type="submit" disabled={Boolean(busy)}>Save password</button>
        </form></details>
      </aside>
      <div className="library-exhibit"><div className="admin-feedback" aria-live="polite">{message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}</div>
        <section className="space-grid" aria-label="Managed spaces">{filtered.map(scene => <article className="space-card" key={scene.sceneId}>
          <a className="space-card-link" href={scene.scenePath} aria-label={`Open ${scene.title}`}><div className="scene-thumbnail"><img src={scene.thumbnail} alt="" loading="lazy" width={960} height={640} /></div><div className="space-card-copy"><h2>{scene.title}</h2></div></a>
          <div className="admin-edit"><a href={`/admin/scenes/${scene.sceneId}`}>Edit space</a></div>
          <div className="admin-visibility"><label htmlFor={`visibility-${scene.sceneId}`}>Visibility</label><select id={`visibility-${scene.sceneId}`} aria-label={`Visibility for ${scene.title}`} value={scene.public ? "public" : "private"} disabled={Boolean(busy)} onChange={event => visibility(scene, event.target.value === "public")}><option value="private">Private</option><option value="public">Public</option></select></div>
        </article>)}</section>
        {!filtered.length && <p className="library-empty">No spaces found.</p>}
      </div>
    </div>
  </div></main>;
}
