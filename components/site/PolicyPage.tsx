import type { ReactNode } from "react";
import { SiteFooter } from "./Chrome";
import SiteHeader from "./SiteHeader";

export type PolicySection = { id: string; title: string; body: ReactNode };

const policies = [{ href: "/terms", label: "Terms" }, { href: "/privacy", label: "Privacy" }];

/** Terms and privacy: numbered sections with a contents column, like a chapter of the manual. */
export default function PolicyPage({ brand, code, title, lede, sections }:
  { brand: string; code: string; title: string; lede: ReactNode; sections: PolicySection[] }) {
  const nav = policies.map(link => ({ ...link, current: link.label === title }));
  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={nav} />
    <main className="site-main">
      <div className="site-title">
        <div><span className="site-code">{code}</span><h1>{title}</h1></div>
        <p>{lede}</p>
      </div>
      <div className="site-doc">
        <nav className="site-doc-contents" aria-label="Contents">
          <ol>{sections.map((section, index) => <li key={section.id}><a href={`#${section.id}`}><span className="site-code">{code}.{index + 1}</span>{section.title}</a></li>)}</ol>
        </nav>
        <article className="site-doc-body">
          {sections.map((section, index) => <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
            <h2 id={`${section.id}-title`}>{section.title}<span className="site-code">{code}.{index + 1}</span></h2>
            {section.body}
          </section>)}
        </article>
      </div>
    </main>
    <SiteFooter brand={brand} links={policies} />
  </div></div>;
}
