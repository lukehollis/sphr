"use client";

import { useMemo } from "react";
import { ChevronLeft, ChevronRight, Footprints, Lightbulb, RotateCcw } from "lucide-react";
import type { RuntimeState, TourPoint, TourUiText } from "@/lib/types";
import { mediaImageUrl, mediaVideoUrl } from "@/lib/media";
import { sanitizeTourHtml } from "@/lib/tour-html";
import { paragraphs } from "@/lib/experience/types";

type Props = {
  point: TourPoint;
  ui?: TourUiText;
  description?: string;
  state: RuntimeState;
  isLastPoint: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** Scavenger hunt: step position, hint and restart. */
  hunt?: { step: number; steps: number; onHint: () => void };
  /** Text in a dark panel, or straight over the view on a gradient from its side. */
  textStyle?: "panel" | "gradient";
};

/** Text written in the tour builder is plain; older authored tours carry HTML. */
function StopText({ value, plain, className }: { value?: string | null; plain: boolean; className: string }) {
  if (!value) return null;
  if (!plain) return <div className={className} dangerouslySetInnerHTML={{ __html: value }} />;
  return <div className={className}>{paragraphs(value).map((part, index) => <p key={index}>{part}</p>)}</div>;
}

/** The closing card after the last stop of a tour or the last find of a hunt. */
export function TourFinale({ text, hunt, onExplore, onRestart }: { text?: string; hunt?: { found: number; steps: number }; onExplore: () => void; onRestart: () => void }) {
  return (
    <section className="tour-overlay tour-finale-layer" aria-live="polite">
      <div className="tour-copy tour-finale">
        <h2 className="tour-finale-title">{hunt ? (hunt.found >= hunt.steps ? "You found everything" : `You found ${hunt.found} of ${hunt.steps}`) : "The end of the tour"}</h2>
        {text && <StopText value={text} plain className="tour-main-text" />}
        <div className="tour-finale-actions">
          <button type="button" className="tour-next" onClick={onExplore}><span className="tour-button-label">Explore freely</span><Footprints size={22} aria-hidden="true" /></button>
          <button type="button" className="tour-restart" onClick={onRestart}><RotateCcw size={18} aria-hidden="true" /> {hunt ? "Play again" : "Start again"}</button>
        </div>
      </div>
    </section>
  );
}

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

export default function TourOverlay({ point, ui, description, state, isLastPoint, onPrevious, onNext, hunt, textStyle = "panel" }: Props) {
  const plain = point.format === "plain";
  const huntStep = hunt && point.find ? state.hunt : undefined;
  const found = Boolean(huntStep?.stepFound);
  const locked = Boolean(hunt && point.find && !found);
  const primaryFile = point.files?.[0];
  const mapUrl = point.mapUrl && /^https:\/\/(?:www\.)?google\.com\/maps(?:\/embed\/|\?)/.test(point.mapUrl) ? point.mapUrl : '';
  // Older tours kept their opening description in a separate start screen.
  // Preserve that copy at an otherwise empty first stop when entering directly.
  const rawText = point.text || (!point.secondaryText && !primaryFile && !mapUrl
    && state.activeSpaceIndex === 0 && state.activePointIndex === 0 ? description : undefined);
  // Builder text is plain and rendered as text; older authored HTML is sanitized.
  const text = useMemo(() => plain ? rawText : sanitizeTourHtml(rawText), [rawText, plain]);
  const secondaryText = useMemo(() => plain ? point.secondaryText : sanitizeTourHtml(point.secondaryText), [point.secondaryText, plain]);

  const nextLabel = locked ? "Find it to go on"
    : hunt ? (isLastPoint ? "Finish" : "Next clue")
    : isLastPoint ? ui?.continueExploringButtonText ?? "Continue exploring" : ui?.nextButtonText ?? "Next";

  const side = point.textPosition === "right" || point.textPosition === "center" ? point.textPosition : "left";
  const styleClass = textStyle === "gradient" ? ` tour-gradient tour-side-${side}` : "";

  return (
    <section className={`tour-overlay${styleClass}`} aria-live="polite">
      {state.guided && Boolean(text || secondaryText || primaryFile || mapUrl || hunt) && (
        <div className={hunt ? "tour-copy tour-hunt" : "tour-copy"}>
          {hunt && <p className="tour-hunt-step">{found ? "Found" : `Clue ${hunt.step} of ${hunt.steps}`}{point.title ? <span>{point.title}</span> : null}</p>}
          {!hunt && point.title && plain && <p className="tour-stop-title">{point.title}</p>}
          {mapUrl && <div><iframe className="tour-map" src={mapUrl} title="Tour location map" referrerPolicy="no-referrer-when-downgrade" />
            <a className="tour-media-link" href={mapUrl.replace(/([?&])output=embed(&|$)/, '$1')} target="_blank" rel="noopener noreferrer">Open map</a></div>}
          {point.files?.map((file, index) => <TourMedia key={`${point.id}-${index}`} file={file} />)}
          {found && point.find?.found
            ? <StopText value={point.find.found} plain className="tour-main-text tour-found-text" />
            : <StopText value={text} plain={plain} className="tour-main-text" />}
          {!found && <StopText value={secondaryText} plain={plain} className="tour-secondary-text" />}
          {locked && state.hunt?.hint && point.find?.hint && <StopText value={point.find.hint} plain className="tour-secondary-text tour-hint-text" />}
          {locked && <button type="button" className="tour-hint" onClick={hunt?.onHint} disabled={state.hunt?.hint && !point.find?.hint}>
            <Lightbulb size={18} aria-hidden="true" /> {state.hunt?.hint ? "Look for the light" : "Hint"}
          </button>}
        </div>
      )}
      {state.guided && (
        <nav className="tour-nav" aria-label="Guided tour navigation">
          <button type="button" className="tour-prev" aria-label={ui?.previousButtonText ?? "Previous"} title={ui?.previousButtonText ?? "Previous"} onClick={onPrevious} disabled={state.navigating || (state.activePointIndex <= 0 && state.activeSpaceIndex <= 0)}>
            <ChevronLeft size={22} aria-hidden="true" />
            <span className="tour-button-label">{ui?.previousButtonText ?? "Previous"}</span>
          </button>
          <button type="button" className={isLastPoint ? "tour-next tour-next-final" : "tour-next"} aria-label={nextLabel} title={nextLabel} onClick={onNext} disabled={state.navigating || locked}>
            <span className="tour-button-label">{nextLabel}</span>
            {isLastPoint ? <Footprints size={22} aria-hidden="true" /> : <ChevronRight size={22} aria-hidden="true" />}
          </button>
        </nav>
      )}
    </section>
  );
}
