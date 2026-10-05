import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import SiteHeader from "@/components/site/SiteHeader";
import { SectionHeader, SiteFooter } from "@/components/site/Chrome";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { billingEnabled } from "@/lib/server/billing";
import { siteBrand } from "@/lib/server/brand";
import { operatorHunts } from "@/lib/server/profiles";

export const dynamic = "force-dynamic";

const title = "Make your own tours and scavenger hunts";
const description = "A walkthrough for teachers and students. Make an account, choose a tomb, temple or museum, describe a guided tour or scavenger hunt, and share it with your class as one link.";

export const metadata: Metadata = {
  title, description, alternates: { canonical: "/learn" },
  openGraph: { title, description, url: "/learn", images: [{ url: "/learn/builder.webp", width: 1600, height: 1000 }] }
};

const legal = [{ href: "/terms", label: "Terms" }, { href: "/privacy", label: "Privacy" }];
const start = "/account/tours/new";

/** Prompts a teacher might start from, each for a kind of space the collection has. */
const examplePrompts = [
  "A scavenger hunt for sixth graders in the tomb of Nefertari. Hide five things a queen would need in the afterlife, with a clue and a hint for each.",
  "A guided tour of Luxor Temple in six stops for a ninth grade world history class, about the Opet Festival. Keep each stop under eighty words.",
  "A mystery for a Latin club at the Library of Celsus. Someone has stolen a scroll, and students find four clues to work out who."
];

type Step = { id: string; title: string; body: ReactNode; shot: string; alt: string };

/**
 * How to build a guided tour or a scavenger hunt, from making an account to sharing the link,
 * for teachers and students arriving from a school library. Each step shows the real screen.
 */
export default async function LearnPage() {
  if (!accountsEnabled()) notFound();
  const brand = siteBrand();
  const user = await currentUser();
  const hunts = await operatorHunts(4);
  const nav = user ? [{ href: "/account", label: "Your spaces" }, { href: "/learn", label: "How to build", current: true }]
    : [{ href: `/account/login?next=${encodeURIComponent(start)}`, label: "Sign in" }];

  const steps: Step[] = [
    { id: "account", title: "Create your account", shot: "signup", alt: "The sign-up page, with Continue with Google and a form for name, email and password",
      body: <>
        <p>Sign up with Google or with your email address. If you use email, open the link we send you to confirm it, and look in spam if it doesn&apos;t arrive.</p>
        <p className="site-hint">Students who only play a tour or a hunt don&apos;t need an account.</p>
      </> },
    { id: "choose", title: "Choose what to make and where", shot: "picker", alt: "Choosing Scavenger hunt and searching the spaces for tombs, with four tombs shown",
      body: <>
        <p>Pick a guided tour or a scavenger hunt, then search {brand}&apos;s spaces for a tomb, temple, museum or city to build in. A space you captured yourself works too.</p>
        {billingEnabled() && <p className="site-hint">Before your first tour we ask you to add a card on a secure page. Making tours and scavenger hunts is free, and nothing is charged unless you host a space of your own.</p>}
      </> },
    { id: "describe", title: "Describe it in a few words", shot: "describe", alt: "The builder open in the tomb of Nefertari, with a request for a sixth grade scavenger hunt typed into the agent box",
      body: <>
        <p>Tell the builder who it&apos;s for, what it should teach and how many stops or finds you want. It drafts every stop, clue and hint in a few minutes while you wait.</p>
        <p className="learn-label">Try something like this</p>
        {examplePrompts.map(prompt => <blockquote key={prompt} className="site-quote learn-prompt">{prompt}</blockquote>)}
      </> },
    { id: "edit", title: "Make it your own", shot: "builder", alt: "A drafted scavenger hunt open in the builder, with the clue about the painted cows in the tomb of Nefertari ready to edit",
      body: <p>Every word can change. Open a stop or a clue to rewrite it, drag objects into place in the view, and add effects, looks, skies and music from the tabs. Save whenever you like.</p> },
    { id: "share", title: "Share it with your class", shot: "share", alt: "The builder settings switched to Anyone with the link, with a Copy the link button",
      body: <p>Switch it from Only you to Anyone with the link, press Save, then copy the link into your class page, slides or an email. It opens in any browser on a laptop, tablet or phone.</p> },
    { id: "play", title: "Play it together", shot: "play", alt: "A scavenger hunt being played in the tomb of Seti I, with a friendly ghost on the stairs and the first clue in the corner",
      body: <p>Students look around and move through the space on their own. A tour leads them stop by stop, and a hunt counts every find until they reach the end.</p> }
  ];

  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} home={user ? "/account" : "/learn"} nav={nav} account={user?.email} signOut={user ? "account" : undefined} />
    <main className="site-main">
      <div className="site-title">
        <div><span className="site-code">L</span><h1>{title}</h1></div>
        <p>For teachers and students. Build inside a real tomb, temple or museum, and share it with your class as one link.</p>
      </div>
      <div className="site-actions learn-actions">
        <a className="site-button site-button-accent" href={start}>Start building<span aria-hidden="true">→</span></a>
        {hunts.length > 0 && <a className="site-button site-button-secondary" href="#examples">Play a scavenger hunt first</a>}
      </div>

      <ol className="learn-steps">
        {steps.map((step, index) => <li key={step.id} id={step.id} className="learn-step" aria-labelledby={`${step.id}-title`}>
          <div className="learn-step-text">
            <span className="site-code">L.{index + 1}</span>
            <h2 id={`${step.id}-title`}>{step.title}</h2>
            {step.body}
          </div>
          <figure className="learn-shot">
            <img src={`/learn/${step.shot}.webp`} alt={step.alt} width={1600} height={1000} loading={index < 2 ? "eager" : "lazy"} decoding="async" />
          </figure>
        </li>)}
      </ol>

      {hunts.length > 0 && <section id="examples" className="learn-examples" aria-labelledby="examples-title">
        <SectionHeader title={<span id="examples-title">Play one first</span>} />
        <p className="learn-lead">Scavenger hunts made with this builder. Open one to see what your students will see.</p>
        <div className="site-grid">
          {hunts.map(hunt => <a key={hunt.id} className="site-card" href={hunt.path}>
            <div className="site-card-media">{hunt.thumbnail && <img src={hunt.thumbnail} alt="" loading="lazy" decoding="async" width={960} height={640} />}</div>
            <div className="site-card-body"><h3>{hunt.title}</h3>{hunt.space && <p>{hunt.space}</p>}</div>
          </a>)}
        </div>
      </section>}

      <section className="learn-end" aria-labelledby="end-title">
        <div>
          <h2 id="end-title">Ready to make one?</h2>
          <p>Start with any space and change everything the builder drafts.</p>
        </div>
        <a className="site-button site-button-accent" href={start}>Start building<span aria-hidden="true">→</span></a>
      </section>
    </main>
    <SiteFooter brand={brand} links={legal} />
  </div></div>;
}
