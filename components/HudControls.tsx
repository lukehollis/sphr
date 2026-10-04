"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Footprints, Menu, Volume2, VolumeX, X } from "lucide-react";
import type { RuntimeState } from "@/lib/types";
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
};

type Props = {
  title?: string;
  details?: SpaceDetails;
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
        {(hasGuidedTour || hasAudio) && <div className="hud-right" aria-label="Viewer settings">
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
        {host && <a className="viewer-host" href={hostHref(host, "badge")} target="_blank" rel="noopener"
          onClick={(event) => trackHostClick(`Hosted on ${host.name}`, event.currentTarget.href)}>
          Hosted on <span className={pixelFont.className}>{host.name}</span>
        </a>}
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
  if (details.capture) rows.push(["Capture", details.capture]);
  if (details.viewpoints) rows.push(["Viewpoints", String(details.viewpoints)]);
  if (details.stops) rows.push([details.stops.label, String(details.stops.count)]);
  if (details.model) rows.push(["3D model", "Included"]);
  if (details.narration) rows.push(["Narration", "Included"]);
  if (details.added) rows.push(["Added", details.added]);
  return (
    <div className="scene-heading" ref={root}>
      <button className="scene-title-button" type="button" aria-expanded={open} aria-controls="scene-details"
        title={open ? "Hide details" : "About this space"} onClick={() => setOpen(value => !value)}>
        <span className="scene-title">{title}</span>
        {open ? <X size={16} aria-hidden="true" /> : <Menu size={16} aria-hidden="true" />}
      </button>
      {open && <div className="scene-details" id="scene-details">
        {details.description && <p>{details.description}</p>}
        {rows.length > 0 && <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      </div>}
    </div>
  );
}
