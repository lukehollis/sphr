"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Footprints, Heart, Menu, Share2, Tag, Volume2, VolumeX, X } from "lucide-react";
import type { RuntimeState } from "@/lib/types";
import { contactHref, formatCapturedOn } from "@/lib/space-info";
import { defaultTagColor, type SpaceTag } from "@/lib/space-tags";
import { embedCode, shareUrl, type ShareView } from "@/lib/share-link";
import { track } from "@/components/Analytics";
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

/** The space's tags, listed to open from the controls, with a switch to hide them in the space. */
export type TagsControl = { list: SpaceTag[]; shown: boolean; onShown: (shown: boolean) => void; onOpen: (id: string) => void };

/** Sharing the page: its address, whether others can open it, and the view a link opens at (read when the panel opens). */
export type ShareControl = { url: string; public: boolean; title: string; tags: boolean; view: () => ShareView | null };

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
  onToggleReconstruction?: () => void;
  onSelectReconstructionVariant?: (id: string) => void;
  /** Offered where the browser can show the space in a VR headset. */
  onEnterVr?: () => void;
  tags?: TagsControl;
  share?: ShareControl;
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
  onToggleGuide,
  onToggleReconstruction,
  onSelectReconstructionVariant,
  onEnterVr,
  tags,
  share
}: Props) {
  const reconstruction = state.reconstruction?.available && onToggleReconstruction ? state.reconstruction : null;
  return (
    <>
      {!state.guided && canToggleView && <div className="hud-left" aria-label="Scene controls">
        <ControlButton label={state.viewMode === "FPV" ? "Switch to orbit view" : "Switch to first-person view"} onClick={onToggleView}>
          {state.viewMode === "FPV" ? <Box size={22} aria-hidden="true" /> : <Footprints size={22} aria-hidden="true" />}
        </ControlButton>
      </div>}
      <header className="viewer-header">
        <SceneHeading title={title} details={details} />
        {(hasGuidedTour || hasAudio || heart || reconstruction || onEnterVr || tags || share) && <div className="hud-right" aria-label="Viewer settings">
          {heart && <HeartButton heart={heart} />}
          {share && <ShareMenu share={share} orbit={state.viewMode === "ORBIT"} />}
          {tags && <TagsMenu tags={tags} />}
          {/* Guided tours set it per stop; the visitor can still compare the site then and now. */}
          {reconstruction && <ControlButton label={reconstruction.visible ? "Show the capture" : "Show the reconstruction"} active={reconstruction.visible} onClick={onToggleReconstruction!}>
            <TempleIcon />
          </ControlButton>}
          {reconstruction?.visible && (reconstruction.variants?.length ?? 0) > 1 && onSelectReconstructionVariant &&
            <select className="reconstruction-period" aria-label="Reconstruction period" value={reconstruction.variant}
              onChange={(event) => onSelectReconstructionVariant(event.target.value)}>
              {reconstruction.variants!.map((variant) => <option key={variant.id} value={variant.id}>{variant.title}</option>)}
            </select>}
          {hasGuidedTour && <button className="guide-toggle" type="button" role="switch" aria-label="Guide" aria-checked={state.guided} title={state.guided ? "Switch to free exploration" : "Switch to guided tour"} onClick={onToggleGuide}>
            <span className="guide-switch" aria-hidden="true" />
            <span>Guide</span>
          </button>}
          {hasAudio && <ControlButton label={state.muted ? "Unmute audio" : "Mute audio"} onClick={onToggleMute}>
            {state.muted ? <VolumeX size={22} aria-hidden="true" /> : <Volume2 size={22} aria-hidden="true" />}
          </ControlButton>}
          {onEnterVr && <ControlButton label="View in VR" active={state.xr} onClick={onEnterVr}>
            <HeadsetIcon />
          </ControlButton>}
        </div>}
      </header>
      {/* Google's credit takes this corner while its 3D map is in view. */}
      {(build || host) && !state.earth && <div className="viewer-corner">
        {/* A new tab, so the tour stays open and signing in works where the viewer is framed on another site. */}
        {build && <a className="viewer-build" href={build} target="_blank" rel="noopener" onClick={(event) => trackBuildClick(event.currentTarget.href)}>Make a scavenger hunt here</a>}
        {host && <a className={`viewer-host ${pixelFont.className}`} href={hostHref(host, "badge")} target="_blank" rel="noopener"
          title={`Hosted on ${host.name}`} onClick={(event) => trackHostClick(`Hosted on ${host.name}`, event.currentTarget.href)}>{host.name}</a>}
      </div>}
    </>
  );
}

/** A temple front, a pediment over columns, drawn like the other control icons. */
function TempleIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 9h18L12 4Z" />
      <path d="M6 12v6M10 12v6M14 12v6M18 12v6" />
      <path d="M3 21h18" />
    </svg>
  );
}

/** A VR headset seen from the front, its two lenses either side of the nose, drawn like the other control icons. */
function HeadsetIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4.5l-2.2-2.6a1.7 1.7 0 0 0-2.6 0L8.5 17H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
      <circle cx="7.5" cy="12" r="1.5" />
      <circle cx="16.5" cy="12" r="1.5" />
    </svg>
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

/**
 * The share button: a link and an embed code for the page, opening at the view on screen when it was
 * opened (the tour stop, or the spot and the way the visitor faces), with tags hidden if asked.
 */
function ShareMenu({ share, orbit }: { share: ShareControl; orbit: boolean }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ShareView | null>(null);
  const [atView, setAtView] = useState(true);
  const [showTags, setShowTags] = useState(true);
  const [copied, setCopied] = useState<"link" | "embed" | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const chosen = atView ? view : null;
  const url = shareUrl(share.url, chosen, { tags: share.tags && !showTags ? false : undefined });
  const code = embedCode(url, share.title);
  function toggle() {
    if (!open) { setView(share.view()); setCopied(null); }
    setOpen(value => !value);
  }
  async function copy(kind: "link" | "embed", text: string, field: HTMLInputElement | HTMLTextAreaElement | null) {
    try { await navigator.clipboard.writeText(text); }
    catch { field?.select(); document.execCommand?.("copy"); }
    setCopied(kind);
    track("share_copy", { kind, view: chosen ? ("stop" in chosen ? "stop" : "spot") : "space" });
  }
  const linkField = useRef<HTMLInputElement | null>(null);
  const codeField = useRef<HTMLTextAreaElement | null>(null);
  return (
    <div className="share-menu" ref={root}>
      <button className={open ? "viewer-button active" : "viewer-button"} type="button" aria-expanded={open} aria-controls="share-panel"
        aria-label="Share or embed" title="Share or embed this space" onClick={toggle}>
        <Share2 size={20} aria-hidden="true" />
      </button>
      {open && <div className="share-panel" id="share-panel" role="dialog" aria-label="Share this space">
        {view ? <label className="share-check">
          <input type="checkbox" checked={atView} onChange={event => setAtView(event.target.checked)} />
          <span>{"stop" in view ? `Open at stop ${view.stop + 1}` : "Open at this view"}</span>
        </label> : orbit && <p className="share-hint">Step inside the space to share the view from where you stand.</p>}
        {share.tags && <label className="share-check">
          <input type="checkbox" checked={showTags} onChange={event => setShowTags(event.target.checked)} />
          <span>Show tags</span>
        </label>}
        <label className="share-label" htmlFor="share-link">Link</label>
        <div className="share-row">
          <input ref={linkField} id="share-link" className="share-field" readOnly value={url} onFocus={event => event.currentTarget.select()} />
          <button type="button" className="share-copy" onClick={() => void copy("link", url, linkField.current)}>{copied === "link" ? "Copied" : "Copy"}</button>
        </div>
        <label className="share-label" htmlFor="share-embed">Embed code</label>
        <div className="share-row share-row--code">
          <textarea ref={codeField} id="share-embed" className="share-field" readOnly rows={3} value={code} onFocus={event => event.currentTarget.select()} />
          <button type="button" className="share-copy" onClick={() => void copy("embed", code, codeField.current)}>{copied === "embed" ? "Copied" : "Copy"}</button>
        </div>
        {!share.public && <p className="share-hint">This space is private, so the link opens only for you and your team.</p>}
      </div>}
    </div>
  );
}

/** The tags button: a list of the space's tags to open, and a switch that hides them in the space. */
function TagsMenu({ tags }: { tags: TagsControl }) {
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
  const count = tags.list.length;
  return (
    <div className="tags-menu" ref={root}>
      <button className={open ? "viewer-button tags-button active" : "viewer-button tags-button"} type="button" aria-expanded={open} aria-controls="tags-panel"
        aria-label={`Tags, ${count}`} title={open ? "Hide the list of tags" : "Tags in this space"} onClick={() => setOpen(value => !value)}>
        <Tag size={20} aria-hidden="true" />
        <span aria-hidden="true">{count}</span>
      </button>
      {open && <div className="tags-panel" id="tags-panel">
        <button className="tags-shown" type="button" role="switch" aria-checked={tags.shown} onClick={() => tags.onShown(!tags.shown)}>
          <span className="guide-switch" aria-hidden="true" />
          <span>Show tags in the space</span>
        </button>
        <ul aria-label="Tags">
          {tags.list.map(tag => <li key={tag.id}>
            <button type="button" onClick={() => { setOpen(false); tags.onOpen(tag.id); }}>
              <span className="tag-card-dot" style={{ background: tag.color ?? defaultTagColor }} aria-hidden="true" />
              <span>{tag.title}</span>
            </button>
          </li>)}
        </ul>
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
