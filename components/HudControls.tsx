"use client";

import { Box, Footprints, Volume2, VolumeX, Captions, CaptionsOff, Expand } from "lucide-react";
import type { RuntimeState } from "@/lib/types";
import ShareLink from "@/components/ShareLink";

type Props = {
  sharePath?: string;
  title?: string;
  state: RuntimeState;
  hasGuidedTour: boolean;
  hasAudio: boolean;
  onToggleView: () => void;
  onToggleMute: () => void;
  onToggleText: () => void;
  onFullscreen: () => void;
  onToggleGuide: () => void;
};

export default function HudControls({
  sharePath,
  title,
  state,
  hasGuidedTour,
  hasAudio,
  onToggleView,
  onToggleMute,
  onToggleText,
  onFullscreen,
  onToggleGuide
}: Props) {
  return (
    <>
      {!state.guided && <div className="hud-left" aria-label="Scene controls">
        <ControlButton label={state.viewMode === "FPV" ? "Switch to orbit view" : "Switch to first-person view"} onClick={onToggleView}>
          {state.viewMode === "FPV" ? <Box size={22} aria-hidden="true" /> : <Footprints size={22} aria-hidden="true" />}
        </ControlButton>
      </div>}
      <header className="viewer-header">
        <div className="scene-heading"><span>{title}</span></div>
      <div className="hud-right" aria-label="Viewer settings">
        {hasGuidedTour && <button className="guide-toggle" type="button" role="switch" aria-label="Guide" aria-checked={state.guided} title={state.guided ? "Switch to free exploration" : "Switch to guided tour"} onClick={onToggleGuide}>
          <span className="guide-switch" aria-hidden="true" />
          <span>Guide</span>
        </button>}
        {sharePath && <ShareLink path={sharePath} title={title ?? "this space"} compact />}
        {hasAudio && <ControlButton label={state.muted ? "Unmute audio" : "Mute audio"} onClick={onToggleMute}>
          {state.muted ? <VolumeX size={22} aria-hidden="true" /> : <Volume2 size={22} aria-hidden="true" />}
        </ControlButton>}
        {hasGuidedTour && <ControlButton label={state.showText ? "Hide text" : "Show text"} onClick={onToggleText} active={state.showText}>
          {state.showText ? <CaptionsOff size={22} aria-hidden="true" /> : <Captions size={22} aria-hidden="true" />}
        </ControlButton>}
        <ControlButton label="Toggle fullscreen" onClick={onFullscreen}>
          <Expand size={22} aria-hidden="true" />
        </ControlButton>
      </div>
      </header>
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
