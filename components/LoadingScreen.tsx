"use client";

import { useId, useState } from "react";
import type { LoadingState } from "@/lib/types";

type Props = {
  loading: LoadingState;
  visible: boolean;
  title?: string;
  image?: string | null;
};

/** The scene opens automatically as soon as its real assets are ready. */
export default function LoadingScreen({ loading, visible, title, image }: Props) {
  const gridId = useId();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  if (!visible) return null;
  const progress = Number.isFinite(loading.progress) ? Math.round(Math.max(0, Math.min(1, loading.progress)) * 100) : 0;
  const status = loading.error ? "Unable to open space" : progress === 100 ? "Opening space" : "Loading space";

  return (
    <div className={`scene-load-screen${loading.error ? " has-error" : ""}`}>
      <div className="scene-load-backdrop" aria-hidden="true">
        {image && image !== failedImage && <img
          className="scene-load-image"
          src={image}
          alt=""
          fetchPriority="high"
          loading="eager"
          decoding="async"
          onError={() => setFailedImage(image)}
        />}
      </div>
      <svg className="scene-load-grid" aria-hidden="true" focusable="false" width="100%" height="100%">
        <defs>
          <pattern id={`${gridId}-minor`} width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 H 0 V 24" fill="none" className="scene-load-grid-minor" />
          </pattern>
          <pattern id={`${gridId}-major`} width="120" height="120" patternUnits="userSpaceOnUse">
            <rect width="120" height="120" fill={`url(#${gridId}-minor)`} />
            <path d="M 120 0 H 0 V 120" fill="none" className="scene-load-grid-major" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${gridId}-major)`} />
      </svg>
      <div className="scene-load-content">
        <svg className="scene-load-drawing" viewBox="0 0 160 144" fill="none" aria-hidden="true" focusable="false">
          <path className="scene-load-construction" d="M80 0V144 M0 72H160 M8 112L152 32 M8 32L152 112 M34 20V124 M126 20V124" />
          <path className="scene-load-hidden-edge" d="M34 98L80 72L126 98 M80 72V20" />
          <path className="scene-load-cube" d="M80 20L126 46V98L80 124L34 98V46Z M34 46L80 72L126 46 M80 72V124" />
        </svg>
        {title && <p className="scene-load-title">{title}</p>}
        <div className="scene-load-meta">
          <span role={loading.error ? "alert" : "status"}>{status}</span>
          {!loading.error && <span className="scene-load-percent" aria-hidden="true">{progress}<span>%</span></span>}
        </div>
        {loading.error ? <>
          <p className="scene-load-error">{loading.error}</p>
          <div className="scene-load-recovery">
            <button type="button" className="primary-action" onClick={() => window.location.reload()}>Retry</button>
            <a href="/">All spaces</a>
          </div>
        </> : <div className="scene-load-progress" role="progressbar" aria-label="Loading space" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <div className="scene-load-track"><span style={{ width: `${progress}%` }} /></div>
          <div className="scene-load-ticks" aria-hidden="true">{Array.from({ length: 11 }, (_, index) => <i key={index} />)}</div>
        </div>}
      </div>
    </div>
  );
}
