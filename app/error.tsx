"use client";

import ErrorSheet from "@/components/site/ErrorSheet";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <ErrorSheet code="500" title="This page didn’t load." text="Something went wrong on our side. Try again in a moment.">
    <button type="button" className="site-button" onClick={reset}>Try again<span aria-hidden="true">→</span></button>
  </ErrorSheet>;
}
