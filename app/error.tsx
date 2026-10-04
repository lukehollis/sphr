"use client";

import { useEffect, useState } from "react";
import ErrorSheet from "@/components/site/ErrorSheet";
import { reportError } from "@/components/Analytics";
import { isMissingPart, reloadOnce } from "@/lib/missing-part";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const missing = isMissingPart(error);
  const [reloading, setReloading] = useState(missing);
  useEffect(() => {
    if (!missing) { reportError("page", error, error.digest ? `digest ${error.digest}` : ""); return; }
    // The <head> script may already have seen this part fail, and reloaded or reported it.
    const seen = window.__sphrMissingPart;
    if (seen === "reloading") return;
    if (!seen) {
      const reloaded = reloadOnce();
      reportError("page", error, reloaded ? "reloaded the page" : "still failing after a reload");
      if (reloaded) return;
    }
    setReloading(false);
  }, [error, missing]);
  if (reloading) return null;
  if (missing) return <ErrorSheet code="500" title="This page didn’t finish loading." text="Part of it didn’t arrive, which usually means the connection dropped. Try again in a moment.">
    <button type="button" className="site-button" onClick={() => window.location.reload()}>Try again<span aria-hidden="true">→</span></button>
  </ErrorSheet>;
  return <ErrorSheet code="500" title="This page didn’t load." text="Something went wrong on our side. Try again in a moment.">
    <button type="button" className="site-button" onClick={reset}>Try again<span aria-hidden="true">→</span></button>
  </ErrorSheet>;
}
