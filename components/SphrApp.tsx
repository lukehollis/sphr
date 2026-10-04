"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadBootstrapData, normalizeTour } from "@/lib/bootstrap";
import type { RuntimeCallbacks, RuntimeState, SphrBootstrap } from "@/lib/types";
import { ViewerSession } from "@/lib/viewer/ViewerSession";
import HudControls from "@/components/HudControls";
import LoadingScreen from "@/components/LoadingScreen";
import TourOverlay, { TourFinale } from "@/components/TourOverlay";
import { applySceneEdits, editorBootstrap, startViewEditingIssue, tourEditorBootstrap, type ViewerEdits } from '@/lib/scene-edits';

const initialRuntimeState: RuntimeState = {
  loading: {
    label: "Loading",
    progress: 0,
    ready: false
  },
  activeSpaceIndex: 0,
  activePointIndex: 0,
  viewMode: "FPV",
  guided: false,
  muted: false,
  showText: true,
  debug: false,
  navigating: false
};

type Props = { configUrl?: string; preview?: { title: string; image: string };
  edits?: ViewerEdits;
  editor?: {
    onReady: (session: ViewerSession | null, issue: string | null) => void;
    onState: (state: RuntimeState) => void;
    /** "tour" opens the tour builder: objects can be selected and moved. */
    mode?: "start" | "tour";
    onObjectSelect?: (id: string | null) => void;
    onObjectTransform?: RuntimeCallbacks["onObjectTransform"];
  };
  /** The tour builder shows visitor controls only while previewing. */
  chrome?: boolean;
  /** Bumped by the tour builder after live edits so overlays re-read the tour. */
  revision?: number;
};

function activePointOf(tour: NonNullable<ReturnType<typeof normalizeTour>>, state: RuntimeState) {
  return tour.spaces[state.activeSpaceIndex]?.tourpoints[state.activePointIndex] ?? null;
}

export default function SphrApp({ configUrl, preview, edits, editor, chrome = !editor, revision = 0 }: Props) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<ViewerSession | null>(null);
  const [bootstrap, setBootstrap] = useState<SphrBootstrap | null>(null);
  const [runtimeState, setRuntimeState] = useState<RuntimeState>(initialRuntimeState);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStarted(false);
    setBootstrap(null);
    setRuntimeState(initialRuntimeState);

    async function boot() {
      try {
        const source = await loadBootstrapData(configUrl);
        const edited = edits ? applySceneEdits(source, edits) : source;
        const tourEditor = editor?.mode === "tour";
        const issue = editor && !tourEditor ? startViewEditingIssue(edited) : null;
        const data = tourEditor ? tourEditorBootstrap(edited) : editor ? editorBootstrap(edited) : edited;
        if (cancelled) return;
        setBootstrap(data);

        if (!viewportRef.current) return;
        const runtime = new ViewerSession(viewportRef.current, data, {
          onState: state => { setRuntimeState(state); editor?.onState(state); },
          onObjectSelect: editor?.onObjectSelect,
          onObjectTransform: editor?.onObjectTransform,
          onLoading: (loading) => {
            setRuntimeState((current) => ({ ...current, loading }));
          }
        });
        runtimeRef.current = runtime;
        if (process.env.NODE_ENV !== "production") {
          (window as Window & { __SPHR_RUNTIME__?: ViewerSession }).__SPHR_RUNTIME__ = runtime;
        }
        if (tourEditor) runtime.setEditing(true);
        await runtime.init();
        if (cancelled) return;
        runtime.start(normalizeTour(data).hasGuidedTour);
        setStarted(true);
        editor?.onReady(runtime, issue);
      } catch (error) {
        if (cancelled) return;
        console.error(error);
        editor?.onReady(null, error instanceof Error ? error.message : 'Unable to load scene.');
        setRuntimeState((current) => ({
          ...current,
          loading: {
            label: "Unable to load scene",
            progress: current.loading.progress,
            ready: false,
            error: error instanceof Error ? error.message : "Unknown runtime error"
          }
        }));
      }
    }

    void boot();

    return () => {
      cancelled = true;
      editor?.onReady(null, null);
      if (process.env.NODE_ENV !== "production") {
        delete (window as Window & { __SPHR_RUNTIME__?: ViewerSession }).__SPHR_RUNTIME__;
      }
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, [configUrl, edits, editor]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tour = useMemo(() => (bootstrap ? normalizeTour(bootstrap) : null), [bootstrap, revision]);
  const hunt = tour?.kind === "hunt" ? tour : null;
  const huntSteps = hunt ? hunt.spaces.flatMap((space) => space.tourpoints).filter((point) => point.find) : [];
  const huntStep = hunt && activePointOf(hunt, runtimeState) ? huntSteps.indexOf(activePointOf(hunt, runtimeState)!) + 1 : 0;
  const activePoint = tour?.spaces[runtimeState.activeSpaceIndex]?.tourpoints[runtimeState.activePointIndex] ?? null;
  const activeSpace = tour?.spaces[runtimeState.activeSpaceIndex] ?? null;
  const viewerSpace = bootstrap?.orderedSpaces?.find(space => String(space.id) === String(activeSpace?.id)) ?? bootstrap?.space;
  const isLastPoint =
    Boolean(tour) &&
    runtimeState.activeSpaceIndex === (tour?.spaces.length ?? 1) - 1 &&
    runtimeState.activePointIndex === ((activeSpace?.tourpoints.length ?? 1) - 1);

  // On phones the tour's text spans the bottom of the screen; the picture centres what a stop
  // looks at in the part above it instead of behind the text.
  const rootRef = useRef<HTMLElement | null>(null);
  const showingCopy = Boolean(started && tour?.hasGuidedTour && runtimeState.guided && activePoint);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const covering = showingCopy ? [...root.querySelectorAll<HTMLElement>(".tour-copy, .tour-nav")].map((element) => element.getBoundingClientRect()).filter((rect) => rect.height > 0) : [];
      const spans = covering.some((rect) => rect.width >= window.innerWidth * 0.8);
      const top = Math.min(...covering.map((rect) => rect.top));
      runtimeRef.current?.setViewInset(spans && Number.isFinite(top) ? Math.max(0, window.innerHeight - top) : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of root.querySelectorAll(".tour-overlay, .tour-copy, .tour-nav")) observer.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [showingCopy, activePoint, runtimeState.hunt?.hint, runtimeState.hunt?.found.length]);

  return (
    <main ref={rootRef} className={`sphr-root${tour?.hasGuidedTour ? " has-guided-tour" : ""}`}>
      <div ref={viewportRef} className="sphr-viewport" />
      <LoadingScreen
        loading={runtimeState.loading}
        visible={!started || !runtimeState.loading.ready}
        title={preview?.title || bootstrap?.space.title}
        image={preview?.image || bootstrap?.ui?.loadingImage || bootstrap?.space.space_data.loadingImage || bootstrap?.space.thumbnail || bootstrap?.space.share_image}
      />

      {started && runtimeState.navigationError && <div className="navigation-status" role="alert">{runtimeState.navigationError}</div>}
      {started && runtimeState.earth && <div className="earth-credit">
        {/* Google asks for its logo and the map's data providers whenever its 3D map is in view. */}
        <img src="https://maps.gstatic.com/mapfiles/api-3/images/google_white5_hdpi.png" alt="Google" width={59} height={18} />
        {runtimeState.earth.credits && <span>{runtimeState.earth.credits}</span>}
      </div>}
      {started && chrome && runtimeState.finished && (tour?.finale || hunt) && <TourFinale
        text={tour?.finale}
        hunt={hunt ? { found: runtimeState.hunt?.found.length ?? 0, steps: huntSteps.length } : undefined}
        onExplore={() => runtimeRef.current?.dismissFinale()}
        onRestart={() => { runtimeRef.current?.restartHunt(); runtimeRef.current?.dismissFinale(); runtimeRef.current?.start(true); void runtimeRef.current?.goTo(0, 0); }}
      />}
      {started && chrome && activePoint && (
        <>
          <HudControls
            title={preview?.title ?? (tour?.hasGuidedTour ? tour.title : bootstrap?.space.title)}
            state={runtimeState}
            hasGuidedTour={tour?.hasGuidedTour ?? false}
            hasAudio={Object.values(tour?.audio ?? {}).some((audio) => Boolean(audio.url?.trim())) || Boolean(tour?.effects.some((effect) => effect.type === "sound" || effect.type === "music"))}
            canToggleView={!viewerSpace?.space_data.noPanos || Boolean(viewerSpace.space_data.clickNavigation || viewerSpace.space_data.splats?.length)}
            onToggleView={() => runtimeRef.current?.toggleViewMode()}
            onToggleMute={() => runtimeRef.current?.toggleMute()}
            onToggleGuide={() => runtimeRef.current?.start(!runtimeState.guided)}
          />
          {tour?.hasGuidedTour && <TourOverlay
            point={activePoint}
            description={bootstrap?.tour?.description}
            ui={bootstrap?.ui}
            state={runtimeState}
            isLastPoint={isLastPoint}
            onPrevious={() => runtimeRef.current?.previous()}
            onNext={() => runtimeRef.current?.next()}
            hunt={hunt && activePoint.find ? { step: Math.max(1, huntStep), steps: huntSteps.length, onHint: () => runtimeRef.current?.requestHint() } : undefined}
          />}
        </>
      )}
    </main>
  );
}
