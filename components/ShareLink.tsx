"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Link as LinkIcon } from "lucide-react";

export default function ShareLink({ path, title, compact = false }: { path: string; title: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    const url = new URL(path, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(url);
      setFallback("");
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } catch { setFallback(url); }
  }

  return <div className={compact ? "share-control share-compact" : "share-control"}>
    <button type="button" className={compact ? "viewer-button" : "share-link-button"}
      aria-label={copied ? "Link copied" : `Copy link to ${title}`} title={copied ? "Link copied" : "Copy scene link"} onClick={copy}>
      {copied ? <Check size={compact ? 22 : 16} aria-hidden="true" /> : <LinkIcon size={compact ? 22 : 16} aria-hidden="true" />}
      {!compact && <span>{copied ? "Copied" : "Copy link"}</span>}
    </button>
    <span className="sr-only" role="status">{copied ? "Scene link copied" : ""}</span>
    {fallback && <div className="share-fallback"><label>Copy this link<input aria-label={`Share URL for ${title}`} readOnly value={fallback} onFocus={event => event.target.select()} /></label><button type="button" onClick={() => setFallback("")}>Close</button></div>}
  </div>;
}
