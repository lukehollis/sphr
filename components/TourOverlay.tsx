"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
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
      {state.guided && state.showText && (
        <div className="tour-copy">
          {imageSrc && <img className="tour-media" src={imageSrc} alt={primaryFile?.title ?? ""} />}
          {videoSrc && <video className="tour-media" src={videoSrc} autoPlay loop muted playsInline />}
          {point.text && <div className="tour-main-text" dangerouslySetInnerHTML={{ __html: point.text }} />}
          {point.secondaryText && <div className="tour-secondary-text" dangerouslySetInnerHTML={{ __html: point.secondaryText }} />}
        </div>
      )}
      {state.guided && (
        <nav className="tour-nav" aria-label="Guided tour navigation">
          <button type="button" className="tour-prev" onClick={onPrevious} disabled={state.activePointIndex <= 0}>
            <ChevronLeft aria-hidden="true" size={20} />
            {ui?.previousButtonText ?? "Previous"}
          </button>
          <button type="button" className={isLastPoint ? "tour-next tour-next-final" : "tour-next"} onClick={onNext}>
            {isLastPoint ? ui?.continueExploringButtonText ?? "Continue Exploring" : ui?.nextButtonText ?? "Next"}
            <ChevronRight aria-hidden="true" size={20} />
          </button>
        </nav>
      )}
    </section>
  );
}
