"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Footprints, Heart, Menu, Volume2, VolumeX, X } from "lucide-react";
import type { RuntimeState } from "@/lib/types";
import { contactHref, formatCapturedOn } from "@/lib/space-info";
import type { ProfileCard } from "@/lib/server/profiles";
import { pixelFont } from "@/app/design-system/fonts";
import { hostHref, trackBuildClick, trackHostClick, type ViewerHost } from "@/lib/host-link";

/** What the viewer can say about the space under its title. */
export type SpaceDetails = {
  description?: string;
  capture?: string;
  viewpoints?: number;
  stops?: { count: number; label: string };
  model?: boolean;
  narration?: boolean;
  added?: string;
  location?: string;
  capturedBy?: string;
  capturedOn?: string;
  contact?: string;
  website?: string;
  credits?: string;
  /** Who made the tour being shown. */
  creator?: ProfileCard;
};

/** A tour's hearts, and whether the visitor has given one. */
export type TourHeart = { tourId: string; count: number; hearted: boolean; signedIn: boolean; loginPath: string };

type Props = {
  title?: string;
  details?: SpaceDetails;
  heart?: TourHeart;
  host?: ViewerHost;
  build?: string;
  state: RuntimeState;
  hasGuidedTour: boolean;
  hasAudio: boolean;
  canToggleView?: boolean;
  onToggleView: () => void;
  onToggleMute: () => void;
  onToggleGuide: () => void;
};

export default function HudControls({
  title,
  details,
  heart,
  host,
  build,
  state,
  hasGuidedTour,
  hasAudio,
  canToggleView = true,
  onToggleView,
  onToggleMute,
  onToggleGuide
}: Props) {
  return (
    <>
      {!state.guided && canToggleView && <div className="hud-left" aria-label="Scene controls">
        <ControlButton label={state.viewMode === "FPV" ? "Switch to orbit view" : "Switch to first-person view"} onClick={onToggleView}>
          {state.viewMode === "FPV" ? <Box size={22} aria-hidden="true" /> : <Footprints size={22} aria-hidden="true" />}
        </ControlButton>
      </div>}
      <header className="viewer-header">
        <SceneHeading title={title} details={details} />
        {(hasGuidedTour || hasAudio || heart) && <div className="hud-right" aria-label="Viewer settings">
          {heart && <HeartButton heart={heart} />}
          {hasGuidedTour && <button className="guide-toggle" type="button" role="switch" aria-label="Guide" aria-checked={state.guided} title={state.guided ? "Switch to free exploration" : "Switch to guided tour"} onClick={onToggleGuide}>
            <span className="guide-switch" aria-hidden="true" />
            <span>Guide</span>
          </button>}
          {hasAudio && <ControlButton label={state.muted ? "Unmute audio" : "Mute audio"} onClick={onToggleMute}>
            {state.muted ? <VolumeX size={22} aria-hidden="true" /> : <Volume2 size={22} aria-hidden="true" />}
          </ControlButton>}
        </div>}
      </header>
      {/* Google's credit takes this corner while its 3D map is in view. */}
      {(build || host) && !state.earth && <div className="viewer-corner">
        {build && <a className="viewer-build" href={build} onClick={(event) => trackBuildClick(event.currentTarget.href)}>Build on this space</a>}
        {host && <a className={`viewer-host ${pixelFont.className}`} href={hostHref(host, "badge")} target="_blank" rel="noopener"
          title={`Hosted on ${host.name}`} onClick={(event) => trackHostClick(`Hosted on ${host.name}`, event.currentTarget.href)}>{host.name}</a>}
      </div>}
    </>
  );
}

function ControlButton({
  label,
  active,
  onClick,
  children
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className={active ? "viewer-button active" : "viewer-button"} type="button" aria-label={label} aria-pressed={active} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

function SceneHeading({ title, details }: { title?: string; details?: SpaceDetails }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);
  if (!details) return <div className="scene-heading"><span className="scene-title">{title}</span></div>;
  const rows: [string, string][] = [];
  const links: [string, string, string][] = [];
  if (details.location) rows.push(["Location", details.location]);
  if (details.capturedBy) rows.push(["Captured by", details.capturedBy]);
  if (details.capturedOn) rows.push(["Captured", formatCapturedOn(details.capturedOn)]);
  if (details.capture) rows.push(["Capture", details.capture]);
  if (details.viewpoints) rows.push(["Viewpoints", String(details.viewpoints)]);
  if (details.stops) rows.push([details.stops.label, String(details.stops.count)]);
  if (details.model) rows.push(["3D model", "Included"]);
  if (details.narration) rows.push(["Narration", "Included"]);
  if (details.added) rows.push(["Added", details.added]);
  const contact = details.contact ? contactHref(details.contact) : undefined;
  if (details.contact && contact) links.push(["Contact", details.contact, contact]);
  if (details.website) links.push(["Website", details.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""), details.website]);
  return (
    <div className="scene-heading" ref={root}>
      <button className="scene-title-button" type="button" aria-expanded={open} aria-controls="scene-details"
        title={open ? "Hide details" : "About this space"} onClick={() => setOpen(value => !value)}>
        {open ? <X size={16} aria-hidden="true" /> : <Menu size={16} aria-hidden="true" />}
        <span className="scene-title">{title}</span>
      </button>
      {open && <div className="scene-details" id="scene-details">
        {details.creator && <a className="scene-creator" href={details.creator.path}>
          <span className="scene-creator-avatar" aria-hidden="true">{details.creator.avatar ? <img src={details.creator.avatar} alt="" width={64} height={64} /> : details.creator.name.slice(0, 1).toUpperCase()}</span>
          <span><small>Made by</small>{details.creator.name}</span>
        </a>}
        {details.description && <p>{details.description}</p>}
        {(rows.length > 0 || links.length > 0) && <dl>
          {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          {links.map(([label, text, href]) => <div key={label}><dt>{label}</dt><dd><a href={href} target="_blank" rel="noopener nofollow">{text}</a></dd></div>)}
        </dl>}
        {details.credits && <p className="scene-credits">{details.credits}</p>}
      </div>}
    </div>
  );
}

/** Hearts a tour; a visitor who is not signed in is sent to sign in and back. */
function HeartButton({ heart }: { heart: TourHeart }) {
  const [state, setState] = useState({ count: heart.count, hearted: heart.hearted });
  const [busy, setBusy] = useState(false);
  async function toggle() {
    if (!heart.signedIn) { window.location.assign(heart.loginPath); return; }
    const next = !state.hearted;
    setBusy(true);
    setState(current => ({ count: current.count + (next ? 1 : -1), hearted: next }));
    try {
      const response = await fetch(`/api/hearts/${heart.tourId}`, { method: next ? "PUT" : "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setState({ count: result.hearts, hearted: result.hearted });
    } catch { setState(current => ({ count: current.count + (next ? -1 : 1), hearted: !next })); }
    finally { setBusy(false); }
  }
  return <button className="heart-toggle" type="button" aria-pressed={state.hearted} disabled={busy}
    aria-label={state.hearted ? "Take back your heart" : "Heart this tour"} title={state.hearted ? "You hearted this tour" : "Heart this tour"} onClick={() => void toggle()}>
    <Heart size={20} aria-hidden="true" fill={state.hearted ? "currentColor" : "none"} />
    <span>{state.count}</span>
  </button>;
}
