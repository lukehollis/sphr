"use client";

import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";

/** A quiet status over the existing view; quick cached loads never flash a spinner. */
export default function ViewLoadingIndicator({ busy }: { busy: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!busy) { setShown(false); return; }
    const timer = setTimeout(() => setShown(true), 220);
    return () => clearTimeout(timer);
  }, [busy]);
  if (!busy || !shown) return null;
  return <div className="view-load-indicator" role="status" aria-live="polite">
    <LoaderCircle size={16} aria-hidden="true" />
    <span>Loading next view</span>
  </div>;
}
