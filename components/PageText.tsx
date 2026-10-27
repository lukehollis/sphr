import type { SearchPage } from "@/lib/server/search-pages";

/**
 * A public page's words as text in the served page, for search engines and screen readers: its name,
 * the tour's stops as the viewer shows them one at a time, where the tour leads, and who made and hosts
 * it. It is visually hidden, and its links stay out of the keyboard's way behind the viewer.
 */
export default function PageText({ page }: { page: SearchPage }) {
  if (!page.indexable) return null;
  const stops = page.text?.stops ?? [];
  return <>
    <article className="sr-only">
      <h1>{page.name}</h1>
      {page.line && <p>{page.line}</p>}
      {page.author && <p>Made by <a href={page.author.path} tabIndex={-1}>{page.author.name}</a></p>}
      {page.about.map((part, index) => <p key={`about-${index}`}>{part}</p>)}
      {stops.length > 0 && <ol>
        {stops.map((stop, index) => <li key={index}>
          {stop.title && <h2>{stop.title}</h2>}
          {stop.text.map((part, line) => <p key={line}>{part}</p>)}
        </li>)}
      </ol>}
      {page.text?.finale.map((part, index) => <p key={`finale-${index}`}>{part}</p>)}
      {page.links.length > 0 && <ul>
        {page.links.map((link) => <li key={link.url}><a href={link.url} tabIndex={-1}>{link.label}</a></li>)}
      </ul>}
      {page.host && <p>Hosted on <a href={page.host.href} tabIndex={-1}>{page.host.name}</a></p>}
    </article>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: page.jsonLd }} />
  </>;
}
