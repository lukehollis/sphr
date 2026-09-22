"use client";

import { useState, type FormEvent } from "react";

type Provider = { id: string; label: string };

export async function accountRequest(url: string, body?: object, method = "POST") {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

const errors: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  expired: "Sign-in took too long. Try again.",
  failed: "Sign-in failed. Try again.",
  busy: "Too many attempts. Try again in a few minutes.",
  email: "That account did not share a verified email address. Use another sign-in method."
};

function ProviderIcon({ id }: { id: string }) {
  if (id === "google") return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.6 12.3c0-.8-.1-1.5-.2-2.3H12v4.3h6a5.1 5.1 0 0 1-2.2 3.4v2.8h3.6c2.1-2 3.2-4.9 3.2-8.2z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.4-2.7l-3.6-2.8c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2v2.9A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.7 14a6.6 6.6 0 0 1 0-4.1V7H2a11 11 0 0 0 0 9.9L5.7 14z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.3 1.7l3.2-3.2A11 11 0 0 0 2 7l3.7 2.9C6.6 7.3 9.1 5.4 12 5.4z"/></svg>;
  if (id === "apple") return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9a4.8 4.8 0 0 0-3.8-2c-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9a5 5 0 0 0-4.2 2.6c-1.8 3.1-.5 7.7 1.3 10.2.8 1.2 1.8 2.6 3.1 2.5 1.2 0 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.4a10 10 0 0 0 1.4-2.8 4.3 4.3 0 0 1-2.1-4.2zM13.9 5a4.4 4.4 0 0 0 1-3.2 4.5 4.5 0 0 0-2.9 1.5 4.2 4.2 0 0 0-1.1 3.1c1.1.1 2.2-.6 3-1.4z"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#0A66C2" d="M20.4 20.5h-3.6v-5.6c0-1.3 0-3-1.8-3s-2.1 1.4-2.1 2.9v5.7H9.3V9h3.4v1.6c.5-.9 1.7-1.8 3.4-1.8 3.6 0 4.3 2.4 4.3 5.5v6.2zM5.3 7.4a2.1 2.1 0 1 1 0-4.2 2.1 2.1 0 0 1 0 4.2zm1.8 13.1H3.5V9h3.6v11.5zM22.2 0H1.8C.8 0 0 .8 0 1.7v20.6c0 .9.8 1.7 1.8 1.7h20.4c1 0 1.8-.8 1.8-1.7V1.7C24 .8 23.2 0 22.2 0z"/></svg>;
}

export default function AccountAuth({ mode: initialMode, providers, passwordEnabled, returnPath, error: errorCode }:
  { mode: "login" | "signup"; providers: Provider[]; passwordEnabled: boolean; returnPath: string; error?: string }) {
  const [mode, setMode] = useState<"login" | "signup" | "forgot">(initialMode);
  const [error, setError] = useState(errorCode ? errors[errorCode] ?? errors.failed : "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError(""); setMessage("");
    try {
      if (mode === "forgot") {
        await accountRequest("/api/account/password/forgot", { email: form.get("email") });
        setMessage("If an account uses that address, we sent a link to reset its password.");
        setBusy(false);
        return;
      }
      await accountRequest(mode === "signup" ? "/api/account/signup" : "/api/account/login",
        { email: form.get("email"), password: form.get("password"), ...(mode === "signup" ? { name: form.get("name") } : {}) });
      window.location.assign(returnPath);
    } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  const next = returnPath === "/account" ? "" : `?next=${encodeURIComponent(returnPath)}`;
  const heading = mode === "signup" ? "Create account" : mode === "forgot" ? "Reset password" : "Sign in";
  return <main className="admin-login account-auth"><div className="admin-form">
    <h1>{heading}</h1>
    {mode !== "forgot" && providers.length > 0 && <div className="account-providers">
      {providers.map(provider => <a key={provider.id} className="account-provider" href={`/api/auth/${provider.id}${next}`}>
        <ProviderIcon id={provider.id} /><span>{`Continue with ${provider.label}`}</span></a>)}
    </div>}
    {mode !== "forgot" && providers.length > 0 && passwordEnabled && <p className="account-divider"><span>or</span></p>}
    {passwordEnabled && <form className="admin-form" onSubmit={submit}>
      {mode === "signup" && <><label htmlFor="name">Name</label><input id="name" name="name" autoComplete="name" maxLength={120} /></>}
      <label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="email" required maxLength={254} />
      {mode !== "forgot" && <><label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={mode === "signup" ? 8 : undefined} maxLength={256} /></>}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button disabled={busy} type="submit">{busy ? "Please wait…" : mode === "signup" ? "Create account" : mode === "forgot" ? "Send reset link" : "Sign in"}</button>
    </form>}
    {!passwordEnabled && error && <p role="alert">{error}</p>}
    <nav className="account-auth-links" aria-label="Account">
      {mode === "login" && passwordEnabled && <button type="button" onClick={() => { setMode("forgot"); setError(""); }}>Forgot password?</button>}
      {mode === "login" ? <a href={`/account/signup${next}`}>Create an account</a> : <a href={`/account/login${next}`}>Sign in instead</a>}
    </nav>
    <p className="account-legal">By continuing you agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</p>
  </div></main>;
}

export function ResetPassword({ token }: { token: string }) {
  const [error, setError] = useState(token ? "" : "This link is incomplete. Request a new one.");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm")) { setError("Passwords do not match."); return; }
    setBusy(true); setError("");
    try {
      await accountRequest("/api/account/password/reset", { token, password: form.get("password") });
      window.location.assign("/account");
    } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  return <main className="admin-login account-auth"><form className="admin-form" onSubmit={submit}>
    <h1>Choose a new password</h1>
    <label htmlFor="password">New password</label><input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={256} />
    <label htmlFor="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={8} maxLength={256} />
    {error && <p role="alert">{error}</p>}
    <button disabled={busy || !token} type="submit">{busy ? "Saving…" : "Save password"}</button>
    <a href="/account/login">Back to sign in</a>
  </form></main>;
}

export function ConfirmEmail({ token }: { token: string }) {
  const [error, setError] = useState(token ? "" : "This link is incomplete. Sign in to send a new one.");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  async function confirm() {
    setBusy(true); setError("");
    try { await accountRequest("/api/account/verify", { token }); setConfirmed(true); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="admin-login account-auth"><div className="admin-form">
    <h1>{confirmed ? "Email address confirmed" : "Confirm your email address"}</h1>
    <p className="admin-help">{confirmed ? "You can now add spaces to your account." : "Confirm that this address belongs to your account."}</p>
    {error && <p role="alert">{error}</p>}
    {!confirmed && <button type="button" disabled={busy || !token} onClick={confirm}>{busy ? "Confirming…" : "Confirm email address"}</button>}
    <a href="/account">{confirmed ? "Continue to your spaces" : "Go to your spaces"}</a>
  </div></main>;
}
