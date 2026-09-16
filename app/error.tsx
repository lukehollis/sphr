"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="library-message"><h1>Unable to open the collection.</h1><p>Please try again in a moment.</p><button type="button" className="share-link-button" onClick={reset}>Try again</button></main>;
}
