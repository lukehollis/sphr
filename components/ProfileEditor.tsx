"use client";

import { useRef, useState, type FormEvent } from "react";
import { Camera, ImagePlus } from "lucide-react";
import SiteHeader from "./site/SiteHeader";
import { SiteFooter, type NavItem } from "./site/Chrome";
import { legalLinks } from "./AccountDashboard";
import { accountRequest } from "./AccountAuth";
import { Avatar, ShareButton } from "./ProfileView";
import type { Profile } from "@/lib/server/profiles";

type Limits = { name: number; bio: number; location: number; website: number };

export default function ProfileEditor({ brand, nav, email, host, profile: initial, limits }:
  { brand: string; nav: NavItem[]; email: string; host: string; profile: Profile; limits: Limits }) {
  const [profile, setProfile] = useState(initial);
  const [form, setForm] = useState({ name: initial.name ?? "", handle: initial.handle, bio: initial.bio ?? "", location: initial.location ?? "", website: initial.website ?? "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const avatarInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [key]: event.target.value }));
  const dirty = form.name !== (profile.name ?? "") || form.handle !== profile.handle || form.bio !== (profile.bio ?? "")
    || form.location !== (profile.location ?? "") || form.website !== (profile.website ?? "");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save"); setError(""); setMessage("");
    try {
      const result = await accountRequest("/api/account/profile", form, "PATCH");
      setProfile(result.profile);
      setForm({ name: result.profile.name ?? "", handle: result.profile.handle, bio: result.profile.bio ?? "", location: result.profile.location ?? "", website: result.profile.website ?? "" });
      setMessage("Profile saved.");
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(null); }
  }

  async function upload(kind: "avatar" | "cover", file: File | undefined) {
    if (!file) return;
    setBusy(kind); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/account/profile/image?kind=${kind}`, { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Unable to upload the picture. Try again.");
      setProfile(current => ({ ...current, [kind]: result.url }));
      setMessage(kind === "avatar" ? "Profile picture updated." : "Cover updated.");
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(null); if (avatarInput.current) avatarInput.current.value = ""; if (coverInput.current) coverInput.current.value = ""; }
  }

  async function removeImage(kind: "avatar" | "cover") {
    setBusy(kind); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/account/profile/image?kind=${kind}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Unable to remove the picture.");
      setProfile(current => ({ ...current, [kind]: null }));
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(null); }
  }

  const path = `/u/${profile.handle}`;
  const shownName = form.name.trim() || form.handle;
  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={nav} account={email} signOut="account" />
    <main className="site-main profile profile-editing">
      <div className="site-title">
        <div><h1>Your profile</h1></div>
        <div className="site-actions"><a className="site-link" href={path}>View your profile</a><ShareButton title={`${shownName} on ${brand}`} path={path} label="Share profile" /></div>
      </div>

      <div className="profile-cover profile-cover-edit">
        {profile.cover ? <img src={profile.cover} alt="" width={2400} height={800} /> : <span className="profile-cover-paper" aria-hidden="true" />}
        <div className="profile-image-actions">
          <button type="button" className="profile-image-button" disabled={Boolean(busy)} onClick={() => coverInput.current?.click()}>
            <ImagePlus size={16} aria-hidden="true" />{busy === "cover" ? "Uploading…" : profile.cover ? "Change cover" : "Add a cover"}</button>
          {profile.cover && <button type="button" className="profile-image-button" disabled={Boolean(busy)} onClick={() => void removeImage("cover")}>Remove</button>}
        </div>
        <input ref={coverInput} type="file" accept="image/*" hidden onChange={event => void upload("cover", event.target.files?.[0])} />
      </div>
      <div className="profile-head">
        <div className="profile-avatar-edit">
          <Avatar name={shownName} src={profile.avatar} />
          <button type="button" className="profile-avatar-button" aria-label={profile.avatar ? "Change profile picture" : "Add a profile picture"} disabled={Boolean(busy)}
            onClick={() => avatarInput.current?.click()}><Camera size={16} aria-hidden="true" /></button>
          <input ref={avatarInput} type="file" accept="image/*" hidden onChange={event => void upload("avatar", event.target.files?.[0])} />
        </div>
        <div className="profile-id">
          <h2>{shownName}</h2>
          <p>@{form.handle}</p>
          {profile.avatar && <button type="button" className="site-link" disabled={Boolean(busy)} onClick={() => void removeImage("avatar")}>Remove picture</button>}
        </div>
      </div>
      <p className="site-hint profile-hint">The cover is shown wide, about three times as wide as it is tall. Pictures are cropped to fit and their location data is removed.</p>

      <form className="site-form profile-form" onSubmit={save}>
        <div className="profile-form-row">
          <div className="site-field"><label htmlFor="profile-name">Name</label>
            <input id="profile-name" className="site-input" value={form.name} maxLength={limits.name} placeholder="How people see you" onChange={set("name")} /></div>
          <div className="site-field"><label htmlFor="profile-handle">Handle</label>
            <input id="profile-handle" className="site-input" value={form.handle} maxLength={30} autoCapitalize="off" spellCheck={false}
              onChange={event => setForm(current => ({ ...current, handle: event.target.value.toLowerCase().replace(/^@/, "") }))} />
            <span className="site-hint">Your profile is at {host}/u/{form.handle || "…"}</span></div>
        </div>
        <div className="site-field"><label htmlFor="profile-bio">Bio</label>
          <textarea id="profile-bio" className="site-input" rows={4} value={form.bio} maxLength={limits.bio} placeholder="What you capture, where, and why" onChange={set("bio")} /></div>
        <div className="profile-form-row">
          <div className="site-field"><label htmlFor="profile-location">Location</label>
            <input id="profile-location" className="site-input" value={form.location} maxLength={limits.location} placeholder="City, country" onChange={set("location")} /></div>
          <div className="site-field"><label htmlFor="profile-website">Website</label>
            <input id="profile-website" className="site-input" value={form.website} maxLength={limits.website} inputMode="url" placeholder="example.com" onChange={set("website")} /></div>
        </div>
        <div className="site-feedback" aria-live="polite">
          {message && <p className="site-note" role="status">{message}</p>}
          {error && <p className="site-alert" role="alert">{error}</p>}
        </div>
        <div className="site-actions"><button type="submit" className="site-button" disabled={Boolean(busy) || !dirty}>{busy === "save" ? "Saving…" : "Save profile"}</button></div>
      </form>
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
  </div></div>;
}
