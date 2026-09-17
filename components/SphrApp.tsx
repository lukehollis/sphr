"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadBootstrapData, normalizeTour } from "@/lib/bootstrap";
import type { RuntimeState, SphrBootstrap } from "@/lib/types";
import { ViewerSession } from "@/lib/viewer/ViewerSession";
import HudControls from "@/components/HudControls";
import LoadingScreen from "@/components/LoadingScreen";
import TourOverlay from "@/components/TourOverlay";

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

type Props = { configUrl?: string; preview?: { title: string; image: string } };

export default function SphrApp({ configUrl, preview }: Props) {
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
        const data = await loadBootstrapData(configUrl);
        if (cancelled) return;
        setBootstrap(data);

        if (!viewportRef.current) return;
        const runtime = new ViewerSession(viewportRef.current, data, {
          onState: setRuntimeState,
          onLoading: (loading) => {
            setRuntimeState((current) => ({ ...current, loading }));
          }
        });
        runtimeRef.current = runtime;
        if (process.env.NODE_ENV !== "production") {
          (window as Window & { __SPHR_RUNTIME__?: ViewerSession }).__SPHR_RUNTIME__ = runtime;
        }
        await runtime.init();
        if (cancelled) return;
        runtime.start(normalizeTour(data).hasGuidedTour);
        setStarted(true);
      } catch (error) {
        if (cancelled) return;
        console.error(error);
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
      if (process.env.NODE_ENV !== "production") {
        delete (window as Window & { __SPHR_RUNTIME__?: ViewerSession }).__SPHR_RUNTIME__;
      }
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, [configUrl]);

  const tour = useMemo(() => (bootstrap ? normalizeTour(bootstrap) : null), [bootstrap]);
  const activePoint = tour?.spaces[runtimeState.activeSpaceIndex]?.tourpoints[runtimeState.activePointIndex] ?? null;
  const activeSpace = tour?.spaces[runtimeState.activeSpaceIndex] ?? null;
  const viewerSpace = bootstrap?.orderedSpaces?.find(space => String(space.id) === String(activeSpace?.id)) ?? bootstrap?.space;
  const isLastPoint =
    Boolean(tour) &&
    runtimeState.activeSpaceIndex === (tour?.spaces.length ?? 1) - 1 &&
    runtimeState.activePointIndex === ((activeSpace?.tourpoints.length ?? 1) - 1);

  return (
    <main className={`sphr-root${tour?.hasGuidedTour ? " has-guided-tour" : ""}`}>
      <div ref={viewportRef} className="sphr-viewport" />
      <LoadingScreen
        loading={runtimeState.loading}
        visible={!started || !runtimeState.loading.ready}
        title={preview?.title || bootstrap?.space.title}
        image={preview?.image || bootstrap?.ui?.loadingImage || bootstrap?.space.space_data.loadingImage || bootstrap?.space.thumbnail || bootstrap?.space.share_image}
      />

      {started && runtimeState.navigationError && <div className="navigation-status" role="alert">{runtimeState.navigationError}</div>}
      {started && activePoint && (
        <>
          <HudControls
            title={tour?.hasGuidedTour ? tour.title : bootstrap?.space.title}
            state={runtimeState}
            hasGuidedTour={tour?.hasGuidedTour ?? false}
            hasAudio={Object.values(tour?.audio ?? {}).some((audio) => Boolean(audio.url?.trim()))}
            canToggleView={!viewerSpace?.space_data.noPanos || Boolean(viewerSpace.space_data.clickNavigation || viewerSpace.space_data.splats?.length)}
            onToggleView={() => runtimeRef.current?.toggleViewMode()}
            onToggleMute={() => runtimeRef.current?.toggleMute()}
            onToggleText={() => runtimeRef.current?.toggleText()}
            onToggleGuide={() => runtimeRef.current?.start(!runtimeState.guided)}
          />
          {tour?.hasGuidedTour && <TourOverlay
            point={activePoint}
            ui={bootstrap?.ui}
            state={runtimeState}
            isLastPoint={isLastPoint}
            onPrevious={() => runtimeRef.current?.previous()}
            onNext={() => runtimeRef.current?.next()}
          />}
        </>
      )}
    </main>
  );
}
