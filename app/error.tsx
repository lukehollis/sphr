"use client";

import { useEffect } from "react";
import ErrorSheet from "@/components/site/ErrorSheet";
import { reportError } from "@/components/Analytics";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { reportError("page", error, error.digest ? `digest ${error.digest}` : ""); }, [error]);
  return <ErrorSheet code="500" title="This page didn’t load." text="Something went wrong on our side. Try again in a moment.">
    <button type="button" className="site-button" onClick={reset}>Try again<span aria-hidden="true">→</span></button>
  </ErrorSheet>;
}
