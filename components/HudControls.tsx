"use client";

import { Box, Footprints, Volume2, VolumeX, Captions, CaptionsOff } from "lucide-react";
import type { RuntimeState } from "@/lib/types";

type Props = {
  title?: string;
  state: RuntimeState;
  hasGuidedTour: boolean;
  hasAudio: boolean;
  canToggleView?: boolean;
  onToggleView: () => void;
  onToggleMute: () => void;
  onToggleText: () => void;
  onToggleGuide: () => void;
};

export default function HudControls({
  title,
  state,
  hasGuidedTour,
  hasAudio,
  canToggleView = true,
  onToggleView,
  onToggleMute,
  onToggleText,
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
        <div className="scene-heading"><span>{title}</span></div>
        {(hasGuidedTour || hasAudio) && <div className="hud-right" aria-label="Viewer settings">
          {hasGuidedTour && <button className="guide-toggle" type="button" role="switch" aria-label="Guide" aria-checked={state.guided} title={state.guided ? "Switch to free exploration" : "Switch to guided tour"} onClick={onToggleGuide}>
            <span className="guide-switch" aria-hidden="true" />
            <span>Guide</span>
          </button>}
          {hasAudio && <ControlButton label={state.muted ? "Unmute audio" : "Mute audio"} onClick={onToggleMute}>
            {state.muted ? <VolumeX size={22} aria-hidden="true" /> : <Volume2 size={22} aria-hidden="true" />}
          </ControlButton>}
          {hasGuidedTour && <ControlButton label={state.showText ? "Hide text" : "Show text"} onClick={onToggleText} active={state.showText}>
            {state.showText ? <CaptionsOff size={22} aria-hidden="true" /> : <Captions size={22} aria-hidden="true" />}
          </ControlButton>}
        </div>}
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
