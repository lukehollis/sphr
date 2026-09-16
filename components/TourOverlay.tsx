"use client";

import { ChevronLeft, ChevronRight, Footprints } from "lucide-react";
import type { RuntimeState, TourPoint, TourUiText } from "@/lib/types";
import { mediaImageUrl, mediaVideoUrl } from "@/lib/media";

type Props = {
  point: TourPoint;
  ui?: TourUiText;
  state: RuntimeState;
  isLastPoint: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

export default function TourOverlay({ point, ui, state, isLastPoint, onPrevious, onNext }: Props) {
  const position = point.textPosition ?? "left";
  const primaryFile = point.files?.[0];
  const mimeType = primaryFile?.mime_type ?? primaryFile?.mimeType ?? "";
  const videoSrc = mimeType.includes("video") ? mediaVideoUrl(primaryFile) : "";
  const imageSrc = !videoSrc ? mediaImageUrl(primaryFile, "900,") : "";

  return (
    <section className={`tour-overlay text-${position}`} aria-live="polite">
      {state.guided && state.showText && Boolean(point.text || point.secondaryText || primaryFile) && (
        <div className="tour-copy">
          {imageSrc && <img className="tour-media" src={imageSrc} alt={primaryFile?.title ?? ""} />}
          {videoSrc && <video className="tour-media" src={videoSrc} autoPlay loop muted playsInline />}
          {point.text && <div className="tour-main-text" dangerouslySetInnerHTML={{ __html: point.text }} />}
          {point.secondaryText && <div className="tour-secondary-text" dangerouslySetInnerHTML={{ __html: point.secondaryText }} />}
        </div>
      )}
      {state.guided && (
        <nav className="tour-nav" aria-label="Guided tour navigation">
          <button type="button" className="tour-prev" aria-label={ui?.previousButtonText ?? "Previous"} title={ui?.previousButtonText ?? "Previous"} onClick={onPrevious} disabled={state.navigating || (state.activePointIndex <= 0 && state.activeSpaceIndex <= 0)}>
            <ChevronLeft size={22} aria-hidden="true" />
            <span className="tour-button-label">{ui?.previousButtonText ?? "Previous"}</span>
          </button>
          <button type="button" className={isLastPoint ? "tour-next tour-next-final" : "tour-next"} aria-label={isLastPoint ? ui?.continueExploringButtonText ?? "Continue exploring" : ui?.nextButtonText ?? "Next"} title={isLastPoint ? ui?.continueExploringButtonText ?? "Continue exploring" : ui?.nextButtonText ?? "Next"} onClick={onNext} disabled={state.navigating}>
            <span className="tour-button-label">{isLastPoint ? ui?.continueExploringButtonText ?? "Continue exploring" : ui?.nextButtonText ?? "Next"}</span>
            {isLastPoint ? <Footprints size={22} aria-hidden="true" /> : <ChevronRight size={22} aria-hidden="true" />}
          </button>
        </nav>
      )}
    </section>
  );
}
