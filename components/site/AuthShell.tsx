import type { ReactNode } from "react";
import { ConstructionDrawing, Wordmark } from "./Chrome";

export type Fact = { code: string; title: string; text: string };

/** Sign-in pages: a drawing plate with the site's case on the left, the form on the right. */
export default function AuthShell({ brand, home = "/account", headline, facts = [], children }:
  { brand: string; home?: string; headline: string; facts?: Fact[]; children: ReactNode }) {
  return <div className="site-auth">
    <section className="site-auth-plate" aria-label={brand}>
      <Wordmark brand={brand} href={home} />
      <div className="site-auth-plate-body">
        <h1 className="site-auth-headline">{headline}</h1>
        <ConstructionDrawing className="site-auth-drawing" />
      </div>
      {facts.length > 0 && <dl className="site-auth-facts">{facts.map(fact => <div key={fact.code}>
        <dt><span className="site-code">{fact.code}</span>{fact.title}</dt><dd>{fact.text}</dd>
      </div>)}</dl>}
    </section>
    <main className="site-auth-panel">{children}</main>
  </div>;
}

/** The price is left to Checkout: people often sign in only to open a space. */
export const customerFacts: Fact[] = [
  { code: "1.1", title: "Upload anything", text: "Matterport and E57 exports, Gaussian splats, 360° photos and video, lidar and meshes." },
  { code: "1.2", title: "Processed for you", text: "Agents build, check and publish each space, then email you." },
  { code: "1.3", title: "Private until shared", text: "Only you can open a space until you make it public." }
];
