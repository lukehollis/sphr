"use client";

import { ChevronLeft, ChevronRight, Footprints } from "lucide-react";
import type { RuntimeState, TourPoint, TourUiText } from "@/lib/types";
import { mediaImageUrl, mediaVideoUrl } from "@/lib/media";

type Props = {
  point: TourPoint;
  ui?: TourUiText;
  description?: string;
  state: RuntimeState;
  isLastPoint: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

function TourMedia({ file }: { file: NonNullable<TourPoint['files']>[number] }) {
  if (file.url && /^https:\/\/www\.youtube(?:-nocookie)?\.com\/embed\/[\w-]+(?:\?.*)?$/.test(file.url)) {
    return <div><iframe className="tour-map" src={file.url} title={file.title || 'Tour video'}
      referrerPolicy="strict-origin-when-cross-origin" allow="encrypted-media; picture-in-picture" />
      <a className="tour-media-link" href={file.url.replace('/embed/', '/watch?v=')} target="_blank" rel="noopener noreferrer">Watch video</a></div>;
  }
  const video = (file.mime_type ?? file.mimeType ?? '').includes('video') ? mediaVideoUrl(file) : '';
  const image = video ? '' : mediaImageUrl(file, '900,');
  return video ? <video className="tour-media" src={video} controls autoPlay loop muted playsInline preload="metadata" />
    : image ? <a href={image} target="_blank" rel="noopener noreferrer"><img className="tour-media" src={image} alt={file.title ?? ''} /></a> : null;
}

export default function TourOverlay({ point, ui, description, state, isLastPoint, onPrevious, onNext }: Props) {
  const position = point.textPosition ?? "left";
  const primaryFile = point.files?.[0];
  const mapUrl = point.mapUrl && /^https:\/\/(?:www\.)?google\.com\/maps(?:\/embed\/|\?)/.test(point.mapUrl) ? point.mapUrl : '';
  // Older tours kept their opening description in a separate start screen.
  // Preserve that copy at an otherwise empty first stop when entering directly.
  const text = point.text || (!point.secondaryText && !primaryFile && !mapUrl
    && state.activeSpaceIndex === 0 && state.activePointIndex === 0 ? description : undefined);

  return (
    <section className={`tour-overlay text-${position}`} aria-live="polite">
      {state.guided && Boolean(text || point.secondaryText || primaryFile || mapUrl) && (
        <div className="tour-copy">
          {mapUrl && <div><iframe className="tour-map" src={mapUrl} title="Tour location map" referrerPolicy="no-referrer-when-downgrade" />
            <a className="tour-media-link" href={mapUrl.replace(/([?&])output=embed(&|$)/, '$1')} target="_blank" rel="noopener noreferrer">Open map</a></div>}
          {point.files?.map((file, index) => <TourMedia key={`${point.id}-${index}`} file={file} />)}
          {text && <div className="tour-main-text" dangerouslySetInnerHTML={{ __html: text }} />}
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
