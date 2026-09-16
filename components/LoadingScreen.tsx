"use client";

import type { LoadingState } from "@/lib/types";

/** A temporary status indicator, never an entrance or play gate. */
export default function LoadingScreen({ loading, visible }: { loading: LoadingState; visible: boolean }) {
  if (!visible) return null;
  const progress = Math.round(Math.max(0, Math.min(1, loading.progress)) * 100);
  return <div className="scene-load-status" role={loading.error ? "alert" : "status"} aria-live="polite">
    <span>{loading.error ?? `Loading space… ${progress}%`}</span>
    {loading.error ? <div className="scene-load-recovery"><button type="button" className="secondary-action" onClick={() => window.location.reload()}>Retry</button><a href="/">All spaces</a></div>
      : <div className="scene-load-track" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>}
  </div>;
}
