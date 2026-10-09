import { htmlToPlainText, paragraphs } from "@/lib/experience/types";
import { sanitizeTourHtml } from "@/lib/tour-html";
import type { RuntimeState, TourContinue, TourPoint, TourUiText, XrPanel, XrPanelButton } from "@/lib/types";

/** The main button's words at a stop, the same on screen and in a headset. */
export function nextButtonLabel({ locked, hunt, isLastPoint, ui }: { locked: boolean; hunt: boolean; isLastPoint: boolean; ui?: TourUiText }) {
  return locked ? "Find it to go on"
    : hunt ? (isLastPoint ? "Finish" : "Next clue")
    : isLastPoint ? ui?.continueExploringButtonText ?? "Continue exploring" : ui?.nextButtonText ?? "Next";
}

/** A stop's text as plain paragraphs: builder text is plain already, older tours carry HTML. */
function plainParagraphs(value: string | null | undefined, plain: boolean) {
  if (!value) return [];
  return paragraphs(plain ? value : htmlToPlainText(sanitizeTourHtml(value)));
}

export type XrPanelInput = {
  state: RuntimeState;
  point: TourPoint | null;
  hasGuidedTour: boolean;
  /** The tour's title, offered when exploring freely. */
  title?: string;
  description?: string;
  ui?: TourUiText;
  isLastPoint: boolean;
  /** Where this stop is in the tour, counted across its spaces. */
  stop?: { index: number; count: number };
  hunt?: { step: number; steps: number; found: number };
  finale?: string;
  continueTo?: TourContinue;
};

/**
 * What the tour panel in a VR headset shows, worked out like the tour's box on screen:
 * the stop's text and buttons in guided mode, the closing card, or a way back into the
 * tour while exploring freely. Spaces without a tour show no panel.
 */
export function xrPanelFor(input: XrPanelInput): XrPanel | null {
  const { state, point, ui, hunt } = input;
  const busy = state.navigating || Boolean(state.loading.busy);
  if (state.finished && (input.finale || hunt)) {
    return {
      title: hunt ? (hunt.found >= hunt.steps ? "You found everything" : `You found ${hunt.found} of ${hunt.steps}`) : "The end of the tour",
      paragraphs: paragraphs(input.finale),
      buttons: [
        { id: "restart", label: hunt ? "Play again" : "Start again" },
        { id: "explore", label: "Explore freely", primary: true }
      ]
    };
  }
  if (!input.hasGuidedTour || !point) return null;
  if (!state.guided) {
    return {
      eyebrow: "Exploring freely",
      title: input.title,
      paragraphs: [],
      buttons: [{ id: "guide", label: hunt ? "Back to the hunt" : "Guided tour", primary: true, enabled: !busy }]
    };
  }
  const plain = point.format === "plain";
  const huntStep = Boolean(hunt && point.find);
  const found = huntStep && Boolean(state.hunt?.stepFound);
  const locked = huntStep && !found;
  const files = point.files?.length ?? 0;
  // Older tours kept their opening description in a separate start screen (see TourOverlay).
  const text = point.text || (!point.secondaryText && !files && !point.mapUrl
    && state.activeSpaceIndex === 0 && state.activePointIndex === 0 ? input.description : undefined);
  const body = found && point.find?.found ? paragraphs(point.find.found)
    : [...plainParagraphs(text, plain), ...(found ? [] : plainParagraphs(point.secondaryText, plain))];
  const hint = locked && state.hunt?.hint && point.find?.hint ? point.find.hint : undefined;
  const first = state.activePointIndex <= 0 && state.activeSpaceIndex <= 0;
  const buttons: XrPanelButton[] = [{ id: "previous", label: ui?.previousButtonText ?? "Previous", enabled: !busy && !first }];
  if (locked) buttons.push({ id: "hint", label: state.hunt?.hint ? "Look for the light" : "Hint", enabled: !(state.hunt?.hint && !point.find?.hint) });
  if (input.isLastPoint && !hunt && input.continueTo) buttons.push({ id: "continue", label: input.continueTo.label, primary: true, enabled: !busy });
  else buttons.push({ id: "next", label: nextButtonLabel({ locked, hunt: Boolean(hunt), isLastPoint: input.isLastPoint, ui }), primary: true, enabled: !busy && !locked });
  return {
    eyebrow: huntStep && hunt ? (found ? "Found" : `Clue ${hunt.step} of ${hunt.steps}`) : input.stop ? `Stop ${input.stop.index} of ${input.stop.count}` : undefined,
    title: point.title || undefined,
    paragraphs: body,
    note: hint ?? (locked ? "Point at it and press the trigger, or pinch, when you find it." : undefined),
    buttons
  };
}

/**
 * Whether to offer VR here: a browser that can show it (Quest Browser, Vision Pro, a PC
 * browser with a headset), not blocked for this frame, and not a phone, where a headset
 * button would only crowd the header.
 */
export async function vrAvailable() {
  if (typeof navigator === "undefined" || !navigator.xr) return false;
  const policy = (document as Document & { permissionsPolicy?: { allowsFeature(name: string): boolean }; featurePolicy?: { allowsFeature(name: string): boolean } });
  const rules = policy.permissionsPolicy ?? policy.featurePolicy;
  if (rules && !rules.allowsFeature("xr-spatial-tracking")) return false;
  const agent = navigator.userAgent;
  if (/Android|iPhone|iPod/i.test(agent) && /Mobile/i.test(agent) && !/VR|Quest|Oculus|Pico|Wolvic/i.test(agent)) return false;
  try { return await navigator.xr.isSessionSupported("immersive-vr"); }
  catch { return false; }
}
