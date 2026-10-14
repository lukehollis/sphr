"use client";

import { useState } from "react";
import AuthShell from "./site/AuthShell";
import { accountRequest } from "./AccountAuth";

type InviteView = {
  id: string;
  name: string;
  joinCode: string;
  joinDomain: string | null;
  planName: string | null;
  planSpaces: number | null;
};

type SignedInUser = {
  email: string;
  emailVerified: boolean;
  alreadyMember: boolean;
  otherTeamName: string | null;
};

export default function TeamJoin({
  brand,
  code,
  invite,
  user,
}: {
  brand: string;
  code: string;
  invite: InviteView | null;
  user: SignedInUser | null;
}) {
  const [joined, setJoined] = useState(Boolean(user?.alreadyMember));
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState("");

  const returnPath = `/account/join/${encodeURIComponent(code)}`;
  const userDomain = user?.email.split("@")[1]?.toLowerCase() ?? "";
  const domainMismatch = Boolean(invite?.joinDomain && user && userDomain !== invite.joinDomain);
  const needsVerification = Boolean(invite?.joinDomain && user && !domainMismatch && !user.emailVerified);

  async function join() {
    if (!invite) return;
    setBusy(true); setError("");
    try {
      await accountRequest("/api/account/team/join", { code: invite.joinCode });
      setJoined(true);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    setBusy(true); setError("");
    try {
      await accountRequest("/api/account/verify/resend");
      setResent(true);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signOutAndSwitch() {
    setBusy(true);
    await fetch("/api/account/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign(`/account/signup?next=${encodeURIComponent(returnPath)}`);
  }

  const heading = !invite
    ? "This invite link is no longer valid"
    : joined
      ? `You're on ${invite.name}`
      : `Join ${invite.name}`;

  const lede = !invite
    ? "Ask your team owner for a current invite link."
    : joined
      ? `Your account shares spaces, tours, and ${invite.planName ? `the ${invite.planName} plan` : "billing"} with ${invite.name}.`
      : !user
        ? invite.joinDomain
          ? `Create an account or sign in with your @${invite.joinDomain} email address to join ${invite.name}.`
          : `Create an account or sign in to join ${invite.name} and share spaces and tours.`
        : domainMismatch
          ? `This invite link is restricted to @${invite.joinDomain} email addresses. You are signed in as ${user.email}.`
          : needsVerification
            ? `Confirm ${user.email} first so we know you own this @${invite.joinDomain} address, then join ${invite.name} below.`
            : `Signed in as ${user.email}.${invite.planName ? ` ${invite.name} is on the ${invite.planName} plan.` : ""}`;

  return <AuthShell brand={brand} headline="Host 3D captures as virtual spaces.">
    <div className="site-auth-form">
      <div className="site-auth-heading">
        <span className="site-code">T.1</span>
        <h2>{heading}</h2>
        <p>{lede}</p>
      </div>

      {invite && !joined && <div className="site-agent-code">
        <span>Team invitation</span>
        <strong>{invite.name}</strong>
        <p>
          {invite.joinDomain ? `For @${invite.joinDomain} accounts` : "Team workspace"}
          {invite.planName ? ` · ${invite.planName} plan` : ""}
        </p>
      </div>}

      {error && <p className="site-alert" role="alert">{error}</p>}
      {resent && <p className="site-note" role="status">Confirmation link sent to {user?.email}.</p>}

      {!invite && (
        <p className="site-auth-switch"><a href="/account">Go to your spaces</a></p>
      )}

      {invite && joined && <>
        <a className="site-button site-button-accent site-button-block" href="/account">
          Go to your spaces<span aria-hidden="true">→</span>
        </a>
        <p className="site-auth-switch"><a href="/account/team">View team settings</a></p>
      </>}

      {invite && !joined && !user && <>
        <a className="site-button site-button-accent site-button-block" href={`/account/signup?next=${encodeURIComponent(returnPath)}`}>
          Create an account<span aria-hidden="true">→</span>
        </a>
        <p className="site-auth-switch">
          Already have an account? <a href={`/account/login?next=${encodeURIComponent(returnPath)}`}>Sign in</a>
        </p>
      </>}

      {invite && !joined && user && domainMismatch && <>
        <button type="button" className="site-button site-button-accent site-button-block" disabled={busy} onClick={() => void signOutAndSwitch()}>
          {busy ? "Switching…" : `Use an @${invite.joinDomain} account`}<span aria-hidden="true">→</span>
        </button>
        <p className="site-auth-switch"><a href="/account">Back to your spaces</a></p>
      </>}

      {invite && !joined && user && !domainMismatch && <>
        {user.otherTeamName && (
          <p className="site-note" role="status">
            You are currently a member of {user.otherTeamName}. Leave {user.otherTeamName} in <a href="/account/team">Team settings</a> before joining {invite.name}.
          </p>
        )}
        <button type="button" className="site-button site-button-accent site-button-block"
          disabled={busy || Boolean(user.otherTeamName)} onClick={() => void join()}>
          {busy ? "Joining…" : `Join ${invite.name}`}<span aria-hidden="true">→</span>
        </button>
        {needsVerification && (
          <p className="site-auth-switch">
            Need a new confirmation email?{" "}
            <button type="button" className="site-link-button" disabled={busy} onClick={() => void resendVerification()}>
              Send a new link
            </button>
          </p>
        )}
        <p className="site-auth-switch"><a href="/account">Go to your spaces</a></p>
      </>}
    </div>
  </AuthShell>;
}
