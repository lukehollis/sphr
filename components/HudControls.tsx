"use client";

import {
  Box,
  Bug,
  Captions,
  CaptionsOff,
  Expand,
  Footprints,
  Lightbulb,
  LightbulbOff,
  Volume2,
  VolumeX
} from "lucide-react";
import type { RuntimeState } from "@/lib/types";

type Props = {
  state: RuntimeState;
  onToggleView: () => void;
  onToggleMute: () => void;
  onToggleText: () => void;
  onToggleDebug: () => void;
  onFullscreen: () => void;
  onToggleGuide: () => void;
};

export default function HudControls({
  state,
  onToggleView,
  onToggleMute,
  onToggleText,
  onToggleDebug,
  onFullscreen,
  onToggleGuide
}: Props) {
  return (
    <>
      <div className="hud-left" aria-label="Scene controls">
        <IconButton label={state.viewMode === "FPV" ? "Switch to orbit view" : "Switch to first-person view"} onClick={onToggleView}>
          {state.viewMode === "FPV" ? <Box size={22} /> : <Footprints size={22} />}
        </IconButton>
        <IconButton label={state.guided ? "Turn off guided tour" : "Turn on guided tour"} onClick={onToggleGuide}>
          {state.guided ? <LightbulbOff size={22} /> : <Lightbulb size={22} />}
        </IconButton>
      </div>
      <div className="hud-right" aria-label="Viewer settings">
        <IconButton label={state.muted ? "Unmute audio" : "Mute audio"} onClick={onToggleMute}>
          {state.muted ? <VolumeX size={22} /> : <Volume2 size={22} />}
        </IconButton>
        <IconButton label={state.showText ? "Hide text" : "Show text"} onClick={onToggleText}>
          {state.showText ? <CaptionsOff size={22} /> : <Captions size={22} />}
        </IconButton>
        <IconButton label="Toggle debug markers" onClick={onToggleDebug} active={state.debug}>
          <Bug size={22} />
        </IconButton>
        <IconButton label="Toggle fullscreen" onClick={onFullscreen}>
          <Expand size={22} />
        </IconButton>
      </div>
    </>
  );
}

function IconButton({
  label,
  active = false,
  onClick,
  children
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className={active ? "icon-button active" : "icon-button"} type="button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}
