"use client";

import { Compass, Play } from "lucide-react";
import type { LoadingState, SphrBootstrap } from "@/lib/types";

type Props = {
  bootstrap: SphrBootstrap;
  loading: LoadingState;
  visible: boolean;
  onStartGuided: () => void;
  onStartExplore: () => void;
};

export default function LoadingScreen({ bootstrap, loading, visible, onStartGuided, onStartExplore }: Props) {
  if (!visible) return null;

  const ui = bootstrap.ui ?? {};
  const background = ui.loadingImage ?? bootstrap.space.space_data.loadingImage ?? bootstrap.space.thumbnail ?? "";
  const progress = Math.round(Math.max(0, Math.min(1, loading.progress)) * 100);
  const canStart = loading.ready && !loading.error;

  return (
    <section className="loading-screen" style={background ? { backgroundImage: `url("${background}")` } : undefined}>
      <div className="loading-shade" />
      <div className="loading-content">
        <h1>
          <span>{ui.titlePart1 ?? "SPHR"}</span>
          <strong>{ui.titlePart2 ?? bootstrap.space.title}</strong>
        </h1>
        <p>{ui.subtitle ?? bootstrap.space.description ?? ""}</p>
        {canStart ? (
          <div className="loading-actions">
            <button className="primary-action" type="button" onClick={onStartGuided}>
              <Play aria-hidden="true" size={18} />
              {ui.enterButtonText ?? "Enter"}
            </button>
            <button className="secondary-action" type="button" onClick={onStartExplore}>
              <Compass aria-hidden="true" size={18} />
              {ui.exploreButtonText ?? "Free Explore"}
            </button>
          </div>
        ) : (
          <div className="loading-progress" role="status" aria-live="polite">
            <span>{loading.error ?? `${ui.loadingText ?? loading.label} ${progress}%`}</span>
            <div>
              <i style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
