"use client";

import { useEffect, useState, type FormEvent } from "react";
import AuthShell, { customerFacts } from "./site/AuthShell";
import { googleEvent } from "./Analytics";

type Provider = { id: string; label: string };

/** Posts JSON to an account route. A failure throws an error carrying the status and the response body. */
export async function accountRequest(url: string, body?: object, method = "POST") {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || "Something went wrong. Try again."), { status: response.status, data });
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

// Apps that open links in their own browser. Google refuses to sign anyone in from these
// (its "disallowed_useragent" error), so the page says so and offers email instead.
const inAppBrowsers: [RegExp, string][] = [[/Instagram/, "Instagram"], [/FBAN|FBAV|FB_IAB/, "Facebook"], [/LinkedInApp/, "LinkedIn"],
  [/\bLine\//, "LINE"], [/musical_ly|BytedanceWebview|TikTok/i, "TikTok"], [/Snapchat/, "Snapchat"], [/Pinterest/, "Pinterest"], [/; wv\)/, ""]];

export default function AccountAuth({ mode: initialMode, providers: allProviders, passwordEnabled, returnPath, error: errorCode, brand }:
  { mode: "login" | "signup"; providers: Provider[]; passwordEnabled: boolean; returnPath: string; error?: string; brand: string }) {
  const [mode, setMode] = useState<"login" | "signup" | "forgot">(initialMode);
  const [error, setError] = useState(errorCode ? errors[errorCode] ?? errors.failed : "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [inApp, setInApp] = useState<string | null>(null);
  useEffect(() => {
    const match = inAppBrowsers.find(([pattern]) => pattern.test(navigator.userAgent));
    if (match) setInApp(match[1]);
  }, []);
  const googleBlocked = inApp !== null && passwordEnabled && allProviders.some(provider => provider.id === "google");
  const providers = googleBlocked ? allProviders.filter(provider => provider.id !== "google") : allProviders;
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
      googleEvent(mode === "signup" ? "sign_up" : "login", { method: "email" });
      window.location.assign(returnPath);
    } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  const next = returnPath === "/account" ? "" : `?next=${encodeURIComponent(returnPath)}`;
  const heading = mode === "signup" ? "Create your account" : mode === "forgot" ? "Reset your password" : "Sign in";
  const lede = mode === "signup" ? "Add a space, upload your capture, and we host it." : mode === "forgot" ? "We will email you a link to choose a new password." : "Welcome back.";
  return <AuthShell brand={brand} headline="Host 3D captures as virtual spaces." facts={customerFacts}>
    <div className="site-auth-form">
      <div className="site-auth-heading"><span className="site-code">{mode === "signup" ? "A.1" : mode === "forgot" ? "A.3" : "A.2"}</span><h2>{heading}</h2><p>{lede}</p></div>
      {mode !== "forgot" && googleBlocked && <p className="site-note">Google sign-in does not work inside {inApp ? `the ${inApp} app` : "this app"}. Use your email below, or open this page in Safari or Chrome.</p>}
      {mode !== "forgot" && providers.length > 0 && <div className="site-providers">
        {providers.map(provider => <a key={provider.id} className="site-provider" href={`/api/auth/${provider.id}${next}`}>
          <ProviderIcon id={provider.id} /><span>{`Continue with ${provider.label}`}</span></a>)}
      </div>}
      {mode !== "forgot" && providers.length > 0 && passwordEnabled && <p className="site-divider"><span>or with email</span></p>}
      {passwordEnabled && <form className="site-form" onSubmit={submit}>
        {mode === "signup" && <div className="site-field"><label htmlFor="name">Name</label><input className="site-input" id="name" name="name" autoComplete="name" maxLength={120} /></div>}
        <div className="site-field"><label htmlFor="email">Email</label><input className="site-input" id="email" name="email" type="email" autoComplete="email" required maxLength={254} /></div>
        {mode !== "forgot" && <div className="site-field">
          <div className="site-field-label"><label htmlFor="password">Password</label>
            {mode === "login" && <button type="button" className="site-link" onClick={() => { setMode("forgot"); setError(""); setMessage(""); }}>Forgot password?</button>}</div>
          <input className="site-input" id="password" name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={mode === "signup" ? 8 : undefined} maxLength={256} />
          {mode === "signup" && <p className="site-hint">At least 8 characters.</p>}
        </div>}
        {error && <p className="site-alert" role="alert">{error}</p>}
        {message && <p className="site-note" role="status">{message}</p>}
        <button className="site-button site-button-block" disabled={busy} type="submit">{busy ? "Please wait…" : mode === "signup" ? "Create account" : mode === "forgot" ? "Send reset link" : "Sign in"}<span aria-hidden="true">→</span></button>
      </form>}
      {!passwordEnabled && error && <p className="site-alert" role="alert">{error}</p>}
      <p className="site-auth-switch">
        {mode === "login" ? <>New here? <a href={`/account/signup${next}`}>Create an account</a></>
          : mode === "signup" ? <>Already have an account? <a href={`/account/login${next}`}>Sign in</a></>
          : <button type="button" className="site-link" onClick={() => { setMode("login"); setError(""); setMessage(""); }}>← Back to sign in</button>}
      </p>
      <p className="site-legal">By continuing you agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</p>
    </div>
  </AuthShell>;
}

export function ResetPassword({ token, brand }: { token: string; brand: string }) {
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
  return <AuthShell brand={brand} headline="Host 3D captures as virtual spaces.">
    <form className="site-auth-form site-form" onSubmit={submit}>
      <div className="site-auth-heading"><span className="site-code">A.4</span><h2>Choose a new password</h2><p>Other sessions are signed out when you save.</p></div>
      <div className="site-field"><label htmlFor="password">New password</label><input className="site-input" id="password" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={256} /></div>
      <div className="site-field"><label htmlFor="confirm">Confirm password</label><input className="site-input" id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={8} maxLength={256} /></div>
      {error && <p className="site-alert" role="alert">{error}</p>}
      <button className="site-button site-button-block" disabled={busy || !token} type="submit">{busy ? "Saving…" : "Save password"}<span aria-hidden="true">→</span></button>
      <p className="site-auth-switch"><a href="/account/login">← Back to sign in</a></p>
    </form>
  </AuthShell>;
}

export function ConfirmEmail({ token, brand }: { token: string; brand: string }) {
  const [error, setError] = useState(token ? "" : "This link is incomplete. Sign in to send a new one.");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  async function confirm() {
    setBusy(true); setError("");
    try { await accountRequest("/api/account/verify", { token }); setConfirmed(true); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  return <AuthShell brand={brand} headline="Host 3D captures as virtual spaces.">
    <div className="site-auth-form">
      <div className="site-auth-heading"><span className="site-code">A.5</span>
        <h2>{confirmed ? "Email address confirmed" : "Confirm your email address"}</h2>
        <p>{confirmed ? "You can now add spaces to your account." : "Confirm that this address belongs to your account."}</p></div>
      {error && <p className="site-alert" role="alert">{error}</p>}
      {confirmed ? <a className="site-button site-button-block" href="/account">Continue to your spaces<span aria-hidden="true">→</span></a>
        : <button type="button" className="site-button site-button-block" disabled={busy || !token} onClick={confirm}>{busy ? "Confirming…" : "Confirm email address"}<span aria-hidden="true">→</span></button>}
      {!confirmed && <p className="site-auth-switch"><a href="/account">Go to your spaces</a></p>}
    </div>
  </AuthShell>;
}
