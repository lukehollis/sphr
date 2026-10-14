"use client";

import { useState, type FormEvent } from "react";
import SiteHeader from "./site/SiteHeader";
import { SectionHeader, SiteFooter } from "./site/Chrome";
import { accountNav, legalLinks, openPortal } from "./AccountDashboard";
import { accountRequest } from "./AccountAuth";
import type { Team, TeamRole } from "@/lib/server/accounts-store";
import type { AccountView } from "@/lib/server/customer-spaces";

function shortDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function extractJoinCode(value: string) {
  return value.trim().replace(/^.*\/account\/join\//i, "").replace(/[/?#].*$/, "").trim().toLowerCase();
}

export default function TeamPage({
  brand,
  origin,
  userId,
  account: initialAccount,
  team: initialTeam,
  role: initialRole,
  operator,
  allTeams: initialAllTeams = [],
}: {
  brand: string;
  origin: string;
  userId: string;
  account: AccountView;
  team: Team | null;
  role: TeamRole | null;
  operator: boolean;
  allTeams?: Team[];
}) {
  const [account, setAccount] = useState(initialAccount);
  const [team, setTeam] = useState<Team | null>(initialTeam);
  const [role, setRole] = useState<TeamRole | null>(initialRole);
  const [allTeams, setAllTeams] = useState<Team[]>(initialAllTeams);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const [createForm, setCreateForm] = useState({ name: "", joinDomain: "" });
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [settingsForm, setSettingsForm] = useState({
    name: initialTeam?.name ?? "",
    joinDomain: initialTeam?.joinDomain ?? "",
  });
  const [provisionForm, setProvisionForm] = useState({
    name: "",
    ownerEmail: "",
    joinDomain: "",
    planName: "Enterprise",
    planSpaces: "200",
  });

  function syncSettings(next: Team | null) {
    setTeam(next);
    if (next) {
      setSettingsForm({ name: next.name, joinDomain: next.joinDomain ?? "" });
    }
  }

  async function copyJoinLink(code: string) {
    const url = `${origin}/account/join/${code}`;
    await navigator.clipboard.writeText(url);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(current => (current === code ? null : current)), 2200);
  }

  async function handleCreateTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create"); setError(""); setMessage("");
    try {
      const result = await accountRequest("/api/account/team", {
        name: createForm.name,
        joinDomain: createForm.joinDomain.trim() || null,
      });
      setAccount(result.account);
      syncSettings(result.team);
      setRole(result.role);
      if (result.allTeams) setAllTeams(result.allTeams);
      setMessage(`Created ${result.team.name}. Share the invite link below with your team.`);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleJoinTeam(code: string) {
    const normalized = extractJoinCode(code);
    if (!normalized) {
      setError("Enter a team invite link or code.");
      return;
    }
    setBusy("join"); setError(""); setMessage("");
    try {
      const result = await accountRequest("/api/account/team/join", { code: normalized });
      setAccount(result.account);
      syncSettings(result.team);
      setRole(result.role);
      setJoinCodeInput("");
      setMessage(`You joined ${result.team.name}.`);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleSaveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!team) return;
    setBusy("settings"); setError(""); setMessage("");
    try {
      const result = await accountRequest("/api/account/team", {
        teamId: team.id,
        name: settingsForm.name,
        joinDomain: settingsForm.joinDomain.trim() || null,
      }, "PATCH");
      setAccount(result.account);
      syncSettings(result.team);
      if (result.allTeams) setAllTeams(result.allTeams);
      setMessage("Team settings saved.");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleResetLink() {
    if (!team || !window.confirm("Reset the invite link? The previous link will stop working.")) return;
    setBusy("reset-link"); setError(""); setMessage("");
    try {
      const result = await accountRequest("/api/account/team", {
        teamId: team.id,
        regenerateJoinCode: true,
      }, "PATCH");
      setAccount(result.account);
      syncSettings(result.team);
      if (result.allTeams) setAllTeams(result.allTeams);
      setMessage("Invite link reset.");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleMakeOwner(targetUserId: string, email: string) {
    if (!team || !window.confirm(`Make ${email} the owner of ${team.name}?`)) return;
    setBusy(`owner:${targetUserId}`); setError(""); setMessage("");
    try {
      const result = await accountRequest(`/api/account/team/members/${targetUserId}`, {
        teamId: team.id,
        role: "owner",
      }, "PATCH");
      setAccount(result.account);
      syncSettings(result.team);
      setRole(result.role);
      setMessage(`${email} is now the team owner.`);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemoveMember(targetUserId: string, label: string) {
    const isSelf = targetUserId === userId;
    if (!team || !window.confirm(isSelf ? `Leave ${team.name}?` : `Remove ${label} from ${team.name}?`)) return;
    setBusy(`remove:${targetUserId}`); setError(""); setMessage("");
    try {
      const result = isSelf
        ? await accountRequest("/api/account/team", {}, "DELETE")
        : await accountRequest(`/api/account/team/members/${targetUserId}`, { teamId: team.id }, "DELETE");
      setAccount(result.account);
      syncSettings(result.team);
      setRole(result.role);
      if (result.allTeams) setAllTeams(result.allTeams);
      setMessage(isSelf ? "You left the team." : `Removed ${label} from ${team.name}.`);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleProvisionEnterprise(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("provision"); setError(""); setMessage("");
    try {
      const result = await accountRequest("/api/account/team", {
        provision: true,
        name: provisionForm.name,
        ownerEmail: provisionForm.ownerEmail.trim() || undefined,
        joinDomain: provisionForm.joinDomain.trim() || null,
        planName: provisionForm.planName.trim() || "Enterprise",
        planSpaces: provisionForm.planSpaces.trim() ? Number(provisionForm.planSpaces) : null,
      });
      setAccount(result.account);
      if (result.team) {
        syncSettings(result.team);
        setRole(result.role);
      }
      if (result.allTeams) setAllTeams(result.allTeams);
      setProvisionForm({ name: "", ownerEmail: "", joinDomain: "", planName: "Enterprise", planSpaces: "200" });
      setMessage(`Provisioned ${result.provisioned.name} (${origin}/account/join/${result.provisioned.joinCode}).`);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const canManageTeam = Boolean(team && (role === "owner" || operator));
  const joinUrl = team ? `${origin}/account/join/${team.joinCode}` : "";
  const settingsDirty = Boolean(team && (settingsForm.name !== team.name || settingsForm.joinDomain !== (team.joinDomain ?? "")));

  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={accountNav(account, "team")} account={account.email} signOut="account" />
    <main className="site-main team-page">
      <a className="site-back" href="/account">← Your spaces</a>
      <div className="site-title">
        <div>
          <h1>{team ? team.name : "Team"}</h1>
          <p className="plan-lead">
            {team
              ? "Everyone on your team shares spaces, guided tours, scavenger hunts, and one hosting plan."
              : "Create a team to share spaces, tours, and billing across your organization, or join an existing team with an invite link."}
          </p>
        </div>
        {team && <div className="site-actions">
          <span className="team-role-badge">{role === "owner" ? "Team owner" : "Team member"}</span>
        </div>}
      </div>

      <div className="site-feedback" aria-live="polite">
        {message && <p className="site-note" role="status">{message}</p>}
        {error && <p className="site-alert" role="alert">{error}</p>}
      </div>

      {!team && account.matchingTeam && <div className="site-callout site-callout-action">
        <p>Your <strong>@{account.matchingTeam.joinDomain}</strong> email address is eligible to join <strong>{account.matchingTeam.name}</strong>.</p>
        <button type="button" className="site-button site-button-accent" disabled={Boolean(busy)}
          onClick={() => void handleJoinTeam(account.matchingTeam!.joinCode)}>
          {busy === "join" ? "Joining…" : `Join ${account.matchingTeam.name}`}<span aria-hidden="true">→</span>
        </button>
      </div>}

      {!team ? <div className="team-split">
        <section className="team-card" aria-labelledby="team-create-title">
          <SectionHeader code="T.1" title={<span id="team-create-title">Create a team</span>} />
          <p className="site-hint">As team owner, your plan covers every space your team hosts, and you can invite members with a link or an email domain.</p>
          <form className="site-form" onSubmit={handleCreateTeam}>
            <div className="site-field">
              <label htmlFor="team-name">Team or organization name</label>
              <input id="team-name" className="site-input" required maxLength={80} placeholder="Acme Museum"
                value={createForm.name} onChange={event => setCreateForm(current => ({ ...current, name: event.target.value }))} />
            </div>
            <div className="site-field">
              <label htmlFor="team-domain">Allowed email domain (optional)</label>
              <input id="team-domain" className="site-input" maxLength={253} autoCapitalize="off" spellCheck={false} placeholder="example.org"
                value={createForm.joinDomain} onChange={event => setCreateForm(current => ({ ...current, joinDomain: event.target.value }))} />
              <span className="site-hint">Leave blank so anyone with your invite link can join, or enter a domain (like <code>example.org</code>) so only verified addresses on that domain can join.</span>
            </div>
            <div className="site-actions">
              <button type="submit" className="site-button site-button-accent" disabled={Boolean(busy) || !createForm.name.trim()}>
                {busy === "create" ? "Creating…" : "Create team"}<span aria-hidden="true">→</span>
              </button>
            </div>
          </form>
        </section>

        <section className="team-card" aria-labelledby="team-join-title">
          <SectionHeader code="T.2" title={<span id="team-join-title">Join a team</span>} />
          <p className="site-hint">Paste the invite link or code shared by your team owner.</p>
          <form className="site-form" onSubmit={event => { event.preventDefault(); void handleJoinTeam(joinCodeInput); }}>
            <div className="site-field">
              <label htmlFor="team-join-code">Invite link or code</label>
              <input id="team-join-code" className="site-input" required placeholder={`${origin}/account/join/...`}
                value={joinCodeInput} onChange={event => setJoinCodeInput(event.target.value)} />
            </div>
            <div className="site-actions">
              <button type="submit" className="site-button" disabled={Boolean(busy) || !joinCodeInput.trim()}>
                {busy === "join" ? "Joining…" : "Join team"}<span aria-hidden="true">→</span>
              </button>
            </div>
          </form>
        </section>
      </div> : <>
        <section className="team-section" aria-labelledby="team-invite-title">
          <SectionHeader code="T.1" title={<span id="team-invite-title">Invite link</span>} />
          <div className="team-invite-box">
            <div className="team-invite-url">
              <code>{joinUrl}</code>
              <span>
                {team.joinDomain
                  ? `Open to anyone with a confirmed @${team.joinDomain} email address.`
                  : "Anyone with this link can join your team."}
              </span>
            </div>
            <div className="site-actions">
              <button type="button" className="site-button" onClick={() => void copyJoinLink(team.joinCode)}>
                {copiedCode === team.joinCode ? "Copied" : "Copy invite link"}
              </button>
              {canManageTeam && <button type="button" className="site-button site-button-secondary" disabled={Boolean(busy)} onClick={() => void handleResetLink()}>
                {busy === "reset-link" ? "Resetting…" : "Reset link"}
              </button>}
            </div>
          </div>
        </section>

        <section className="team-section" aria-labelledby="team-billing-title">
          <SectionHeader code="T.2" title={<span id="team-billing-title">Plan and billing</span>} />
          <div className="spaces-billing">
            <p>
              <strong>{team.planName ?? (account.subscription?.plan?.spaces ? `Up to ${account.subscription.plan.spaces} spaces` : account.subscription ? "Pay as you go" : "No active plan")}</strong>
              <span>
                {account.subscription?.plan?.spaces
                  ? `${account.spaceCount} of ${account.subscription.plan.spaces} spaces used`
                  : `${account.spaceCount} ${account.spaceCount === 1 ? "space" : "spaces"}`}
              </span>
              {account.team?.invoiced ? <span>Enterprise · billed by invoice</span> : null}
            </p>
            <span className="spaces-billing-actions">
              {role === "owner" && !account.team?.invoiced && account.billing && <>
                <a className="site-link" href="/account/plan">{account.subscription ? "Change plan" : "Choose a plan"}</a>
                {account.subscription && <button type="button" className="site-link" disabled={Boolean(busy)}
                  onClick={() => { setBusy("portal"); void openPortal().catch(err => { setError((err as Error).message); setBusy(null); }); }}>
                  {busy === "portal" ? "Opening…" : "Billing and invoices"}
                </button>}
              </>}
            </span>
          </div>
        </section>

        <section className="team-section" aria-labelledby="team-members-title">
          <SectionHeader code="T.3" title={<span id="team-members-title">Members ({team.members.length})</span>} />
          <ul className="team-members">
            {team.members.map(member => <li key={member.userId}>
              <div className="team-member-info">
                <strong>{member.name ? `${member.name} (${member.email})` : member.email}</strong>
                <small>{member.role === "owner" ? "Owner · bills for the team" : "Member"} · Joined {shortDate(member.created)}</small>
              </div>
              <div className="site-actions">
                {canManageTeam && member.role !== "owner" && (
                  <button type="button" className="site-button site-button-secondary" disabled={Boolean(busy)}
                    onClick={() => void handleMakeOwner(member.userId, member.email)}>
                    {busy === `owner:${member.userId}` ? "Updating…" : "Make owner"}
                  </button>
                )}
                {(canManageTeam || member.userId === userId) && !(member.role === "owner" && team.members.length > 1) && (
                  <button type="button" className="site-button site-button-secondary" disabled={Boolean(busy)}
                    onClick={() => void handleRemoveMember(member.userId, member.email)}>
                    {busy === `remove:${member.userId}` ? "Removing…" : member.userId === userId ? (team.members.length === 1 && !team.planSpaces ? "Delete team" : "Leave team") : "Remove"}
                  </button>
                )}
              </div>
            </li>)}
          </ul>
        </section>

        {canManageTeam && <section className="team-section" aria-labelledby="team-settings-title">
          <SectionHeader code="T.4" title={<span id="team-settings-title">Team settings</span>} />
          <form className="site-form profile-form" onSubmit={handleSaveSettings}>
            <div className="profile-form-row">
              <div className="site-field">
                <label htmlFor="settings-team-name">Team name</label>
                <input id="settings-team-name" className="site-input" required maxLength={80}
                  value={settingsForm.name} onChange={event => setSettingsForm(current => ({ ...current, name: event.target.value }))} />
              </div>
              <div className="site-field">
                <label htmlFor="settings-team-domain">Allowed email domain</label>
                <input id="settings-team-domain" className="site-input" maxLength={253} autoCapitalize="off" spellCheck={false} placeholder="Anyone with the invite link"
                  value={settingsForm.joinDomain} onChange={event => setSettingsForm(current => ({ ...current, joinDomain: event.target.value }))} />
                <span className="site-hint">When set (for example <code>newalexandriafoundation.org</code>), only confirmed addresses at that domain can join with the invite link.</span>
              </div>
            </div>
            <div className="site-actions">
              <button type="submit" className="site-button" disabled={Boolean(busy) || !settingsDirty}>
                {busy === "settings" ? "Saving…" : "Save team settings"}
              </button>
            </div>
          </form>
        </section>}
      </>}

      {operator && <section className="team-section" aria-labelledby="operator-teams-title">
        <SectionHeader code="OP" title={<span id="operator-teams-title">Enterprise &amp; team provisioning (Operator)</span>} />
        <p className="site-hint">Provision or update an invoiced enterprise team with an optional domain-restricted join link.</p>
        <form className="site-form profile-form" onSubmit={handleProvisionEnterprise}>
          <div className="profile-form-row">
            <div className="site-field">
              <label htmlFor="prov-name">Team name</label>
              <input id="prov-name" className="site-input" required maxLength={80} placeholder="New Alexandria Foundation"
                value={provisionForm.name} onChange={event => setProvisionForm(current => ({ ...current, name: event.target.value }))} />
            </div>
            <div className="site-field">
              <label htmlFor="prov-domain">Allowed email domain (optional)</label>
              <input id="prov-domain" className="site-input" maxLength={253} autoCapitalize="off" spellCheck={false} placeholder="newalexandriafoundation.org"
                value={provisionForm.joinDomain} onChange={event => setProvisionForm(current => ({ ...current, joinDomain: event.target.value }))} />
            </div>
          </div>
          <div className="profile-form-row">
            <div className="site-field">
              <label htmlFor="prov-owner">Owner email (optional)</label>
              <input id="prov-owner" className="site-input" type="email" placeholder="First member to join becomes owner if blank"
                value={provisionForm.ownerEmail} onChange={event => setProvisionForm(current => ({ ...current, ownerEmail: event.target.value }))} />
            </div>
            <div className="site-field">
              <label htmlFor="prov-spaces">Included plan spaces</label>
              <input id="prov-spaces" className="site-input" type="number" min={1} max={10000}
                value={provisionForm.planSpaces} onChange={event => setProvisionForm(current => ({ ...current, planSpaces: event.target.value }))} />
            </div>
          </div>
          <div className="site-actions">
            <button type="submit" className="site-button" disabled={Boolean(busy) || !provisionForm.name.trim()}>
              {busy === "provision" ? "Provisioning…" : "Provision enterprise team"}
            </button>
          </div>
        </form>

        {allTeams.length > 0 && <ul className="team-members">
          {allTeams.map(item => <li key={item.id}>
            <div className="team-member-info">
              <strong>{item.name}</strong>
              <small>
                {item.planName ?? "Standard"}{item.planSpaces ? ` · ${item.planSpaces} spaces` : ""}
                {item.joinDomain ? ` · @${item.joinDomain}` : " · Open link"}
                {` · ${item.members.length} ${item.members.length === 1 ? "member" : "members"}`}
                {` · ${origin}/account/join/${item.joinCode}`}
              </small>
            </div>
            <div className="site-actions">
              <button type="button" className="site-button site-button-secondary" onClick={() => void copyJoinLink(item.joinCode)}>
                {copiedCode === item.joinCode ? "Copied" : "Copy join link"}
              </button>
            </div>
          </li>)}
        </ul>}
      </section>}
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
  </div></div>;
}
