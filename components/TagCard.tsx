"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { defaultTagColor, textRuns, videoPlayer, type SpaceTag, type TagMedia } from "@/lib/space-tags";

/** Text with its web addresses linked, never read as markup. */
export function LinkedText({ text }: { text: string }) {
  return <>{text.split(/\n{2,}/).map((paragraph, index) => <p key={index}>
    {paragraph.split("\n").map((line, row) => <span key={row}>{row > 0 && <br />}{textRuns(line).map((run, part) => run.href
      ? <a key={part} href={run.href} target="_blank" rel="noopener nofollow ugc">{run.text}</a>
      : <span key={part}>{run.text}</span>)}</span>)}
  </p>)}</>;
}

function hostOf(url: string) {
  try { return new URL(url, window.location.href).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** A tag's photo, its video (a YouTube or Vimeo player, or the file), or nothing for a link, which goes under the text. */
export function TagMediaView({ media, title }: { media: TagMedia; title: string }) {
  // A photo that cannot load (its server is down, say) leaves the card rather than showing a broken image.
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  if (media.type === "image") return <img className="tag-card-image" src={media.url} alt={title} loading="lazy" onError={() => setFailed(true)} />;
  if (media.type !== "video") return null;
  const player = videoPlayer(media.url);
  if (player?.kind === "frame") return <div className="tag-card-video"><iframe src={player.src} title={title} loading="lazy" referrerPolicy="strict-origin-when-cross-origin"
    allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen /></div>;
  if (player?.kind === "file") return <div className="tag-card-video"><video src={player.src} controls playsInline preload="metadata" /></div>;
  return null;
}

/** The card a tag opens: its title, photo or video, description and link. */
export default function TagCard({ tag, onClose }: { tag: SpaceTag; onClose: () => void }) {
  const root = useRef<HTMLElement | null>(null);
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [tag.id, onClose]);
  const link = tag.media && (tag.media.type === "link" || (tag.media.type === "video" && !videoPlayer(tag.media.url))) ? tag.media.url : null;
  return <aside ref={root} className="tag-card" role="dialog" aria-labelledby="tag-card-title" tabIndex={-1}>
    <header className="tag-card-head">
      <span className="tag-card-dot" style={{ background: tag.color ?? defaultTagColor }} aria-hidden="true" />
      <h2 id="tag-card-title">{tag.title}</h2>
      <button className="tag-card-close" type="button" aria-label="Close" title="Close" onClick={onClose}><X size={18} aria-hidden="true" /></button>
    </header>
    {tag.media && <TagMediaView key={tag.media.url} media={tag.media} title={tag.title} />}
    {tag.description && <div className="tag-card-text"><LinkedText text={tag.description} /></div>}
    {link && <a className="tag-card-link" href={link} target="_blank" rel="noopener nofollow ugc">{tag.media?.type === "video" ? "Watch on" : "Open"} {hostOf(link)} <ExternalLink size={14} aria-hidden="true" /></a>}
  </aside>;
}
