"use client";

import { useState } from "react";
import { Heart, MapPin, Link as LinkIcon, Share2 } from "lucide-react";
import SiteHeader from "./site/SiteHeader";
import { ConstructionDrawing, SiteFooter, type NavItem } from "./site/Chrome";
import { legalLinks } from "./AccountDashboard";
import { accountRequest } from "./AccountAuth";
import type { SharedCapture, SharedTour } from "@/lib/server/profiles";

export type ProfilePageData = {
  handle: string; name: string; bio: string | null; location: string | null; website: string | null;
  avatar: string | null; cover: string | null; joined: string; path: string;
  followers: number; following: number; tours: SharedTour[]; captures: SharedCapture[];
  viewer: { signedIn: boolean; self: boolean; following: boolean };
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function Avatar({ name, src, size = "large" }: { name: string; src: string | null; size?: "large" | "small" }) {
  return <span className={`profile-avatar profile-avatar-${size}`} aria-hidden="true">
    {src ? <img src={src} alt="" width={512} height={512} /> : <span>{name.slice(0, 1).toUpperCase()}</span>}
  </span>;
}

/** Copies or shares a page's address, saying when it worked. */
export function ShareButton({ title, path, label = "Share" }: { title: string; path: string; label?: string }) {
  const [done, setDone] = useState(false);
  async function share() {
    const url = new URL(path, window.location.origin).toString();
    try {
      if (navigator.share && window.matchMedia("(pointer: coarse)").matches) await navigator.share({ title, url });
      else { await navigator.clipboard.writeText(url); setDone(true); window.setTimeout(() => setDone(false), 2000); }
    } catch { /* the visitor closed the share sheet */ }
  }
  return <button type="button" className="site-button site-button-secondary profile-share" onClick={() => void share()}>
    <Share2 size={16} aria-hidden="true" />{done ? "Link copied" : label}
  </button>;
}

export default function ProfileView({ brand, profile, nav }: { brand: string; profile: ProfilePageData; nav: NavItem[] }) {
  const [following, setFollowing] = useState(profile.viewer.following);
  const [followers, setFollowers] = useState(profile.followers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function follow() {
    if (!profile.viewer.signedIn) { window.location.assign(`/account/login?next=${encodeURIComponent(profile.path)}`); return; }
    setBusy(true); setError("");
    try {
      const result = await accountRequest(`/api/follows/${profile.handle}`, {}, following ? "DELETE" : "PUT");
      setFollowing(result.following); setFollowers(result.followers);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  const joined = new Date(profile.joined).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const empty = !profile.tours.length && !profile.captures.length;
  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} home="/account" nav={nav} />
    <main className="site-main profile">
      <div className="profile-cover">{profile.cover ? <img src={profile.cover} alt="" width={2400} height={800} /> : <span className="profile-cover-paper" aria-hidden="true" />}</div>
      <div className="profile-head">
        <Avatar name={profile.name} src={profile.avatar} />
        <div className="profile-id">
          <h1>{profile.name}</h1>
          <p>@{profile.handle}</p>
        </div>
        <div className="profile-actions">
          {profile.viewer.self ? <a className="site-button site-button-secondary" href="/account/profile">Edit profile</a>
            : <button type="button" className={`site-button${following ? " site-button-secondary" : ""}`} aria-pressed={following} disabled={busy} onClick={() => void follow()}>
              {following ? "Following" : "Follow"}</button>}
          <ShareButton title={`${profile.name} on ${brand}`} path={profile.path} />
        </div>
      </div>
      {error && <p className="site-alert" role="alert">{error}</p>}
      {profile.bio && <p className="profile-bio">{profile.bio}</p>}
      <ul className="profile-facts">
        {profile.location && <li><MapPin size={15} aria-hidden="true" />{profile.location}</li>}
        {profile.website && <li><LinkIcon size={15} aria-hidden="true" /><a href={profile.website} rel="noopener nofollow ugc" target="_blank">{profile.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</a></li>}
        <li>Joined {joined}</li>
      </ul>
      <dl className="profile-counts">
        <div><dt>Tours</dt><dd>{profile.tours.length}</dd></div>
        <div><dt>Captures</dt><dd>{profile.captures.length}</dd></div>
        <div><dt>Followers</dt><dd>{followers}</dd></div>
        <div><dt>Following</dt><dd>{profile.following}</dd></div>
      </dl>

      {profile.tours.length > 0 && <section className="profile-section" aria-labelledby="profile-tours">
        <h2 id="profile-tours">Tours</h2>
        <div className="spaces-grid">{profile.tours.map(tour => <article key={tour.id} className="space-card">
          <a className="space-card-media" href={tour.path} aria-label={`Open ${tour.title}`}>
            {tour.thumbnail ? <img src={tour.thumbnail} alt="" loading="lazy" width={960} height={640} /> : <span className="space-art" aria-hidden="true"><ConstructionDrawing /></span>}
            <span className="space-card-tag profile-kind">{tour.kind === "hunt" ? "Scavenger hunt" : "Guided tour"}</span>
          </a>
          <div className="space-card-body">
            <h3><a href={tour.path}>{tour.title}</a></h3>
            <p className="profile-card-line"><span>{tour.space ? `In ${tour.space}` : plural(tour.stops, "stop", "stops")}</span>
              <span className="profile-hearts" aria-label={plural(tour.hearts, "heart", "hearts")}><Heart size={13} aria-hidden="true" />{tour.hearts}</span></p>
          </div>
        </article>)}</div>
      </section>}

      {profile.captures.length > 0 && <section className="profile-section" aria-labelledby="profile-captures">
        <h2 id="profile-captures">Captures</h2>
        <div className="spaces-grid">{profile.captures.map(capture => <article key={capture.sceneId} className="space-card">
          <a className="space-card-media" href={capture.path} aria-label={`Open ${capture.title}`}><img src={capture.thumbnail} alt="" loading="lazy" width={960} height={640} /></a>
          <div className="space-card-body"><h3><a href={capture.path}>{capture.title}</a></h3></div>
        </article>)}</div>
      </section>}

      {empty && <div className="site-empty profile-empty">
        <ConstructionDrawing />
        <div>
          <h3>{profile.viewer.self ? "Share a tour or a capture to show it here" : "Nothing shared yet"}</h3>
          <p>{profile.viewer.self ? "Tours you share and spaces you make public appear on your profile." : `When ${profile.name} shares a tour or a capture, it appears here.`}</p>
        </div>
      </div>}
    </main>
    <SiteFooter brand={brand} links={legalLinks} />
  </div></div>;
}
