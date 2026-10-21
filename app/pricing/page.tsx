import { notFound } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import SiteHeader from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/Chrome";
import PricingAction, { type PricingActionProps } from "@/components/site/PricingAction";
import SpaceUsage from "@/components/site/SpaceUsage";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { readUser } from "@/lib/server/accounts-store";
import { salesEmail, siteBrand } from "@/lib/server/brand";
import { billingEnabled, readPlans, type Plan } from "@/lib/server/billing";
import { describeAccount } from "@/lib/server/customer-spaces";
import { previewDays } from "@/lib/server/previews";
import { FREE_PLAYERS } from "@/lib/server/tour-plays";
import { FREE_AGENT_DRAFTS } from "@/lib/server/user-tours";
import { formatMoney, formatPeriod } from "@/lib/price";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Pricing",
  description: "Building tours and scavenger hunts is free. A hosting plan puts 3D spaces of your own online and shows every player in your results."
};

/** One plan as a card: its prices (monthly and yearly of the same Stripe product) and what it gives. */
type Offer = { product: string; name: string; key: string; spaces: number | null; prices: Plan[] };

/**
 * Schools and districts don't buy Spacery plans of their own. Mused for Schools covers Mused's tours and simulations
 * for every student, with help on school networks and copies that run offline, and a school that hosts captures of
 * its own on Spacery takes an Enterprise account.
 */
const schoolsUrl = "https://mused.com/edu/pricing/";

function groupOffers(plans: Plan[]) {
  const offers: Offer[] = [];
  for (const plan of plans) {
    const product = plan.product || plan.id;
    const found = offers.find(offer => offer.product === product);
    if (found) found.prices.push(plan);
    else offers.push({ product, name: plan.name, key: plan.key ?? plan.name.toLowerCase(), spaces: plan.spaces, prices: [plan] });
  }
  return offers;
}

const yearly = (offer: Offer) => offer.prices.find(plan => plan.interval === "year" && plan.intervalCount === 1);
const monthly = (offer: Offer) => offer.prices.find(plan => plan.interval === "month" && plan.intervalCount === 1);
const amount = (plan: Plan) => formatMoney(plan.amount, plan.currency);
const price = (plan: Plan) => `${amount(plan)} ${formatPeriod(plan.interval, plan.intervalCount)}`;
const spacesText = (count: number) => count === 1 ? "one space" : `up to ${count} spaces`;

/** "27%" when paying yearly costs less than twelve months, if it saves enough to mention. */
function yearlySaving(offer: Offer) {
  const year = yearly(offer), month = monthly(offer);
  if (!year || !month || year.currency !== month.currency) return undefined;
  const saving = Math.round((1 - year.amount / (month.amount * 12)) * 100);
  return saving >= 5 ? `${saving}%` : undefined;
}

function Card({ name, flag, flagMuted = false, audience, plan, alternative, features, actions, note, featured = false }: {
  name: string; flag?: string; flagMuted?: boolean; audience: string; plan: { amount: string; period: string }; alternative?: ReactNode;
  features: string[]; actions: ReactNode; note?: ReactNode; featured?: boolean }) {
  return <article className={`pricing-card${featured ? " pricing-card-featured" : ""}`} aria-label={name}>
    <header className="pricing-card-head">
      {flag && <p className={`pricing-flag${flagMuted ? " pricing-flag-small" : ""}`}>{flag}</p>}
      <h3>{name}</h3>
      <p className="pricing-for">{audience}</p>
    </header>
    <div className="pricing-price">
      <p><b>{plan.amount}</b><span>{plan.period}</span></p>
      {alternative && <p className="pricing-alt">{alternative}</p>}
    </div>
    <ul className="pricing-features">{features.map(feature => <li key={feature}>{feature}</li>)}</ul>
    <div className="pricing-actions">{actions}</div>
    {note && <p className="pricing-note">{note}</p>}
  </article>;
}

/**
 * What it costs, with a button on every plan. Amounts and names come from Stripe, so the page never
 * disagrees with Checkout. Signed-out visitors sign up first and land on the plan page with the plan
 * chosen; signed-in customers who can pay go straight to Checkout.
 */
export default async function PricingPage() {
  if (!accountsEnabled()) notFound();
  const brand = siteBrand();
  const billing = billingEnabled();
  const plans = billing ? await readPlans() : [];
  const sales = salesEmail();
  const user = await currentUser();
  const account = user ? describeAccount(readUser(user.id)!) : undefined;
  const subscription = account?.subscription;
  const live = Boolean(subscription && ["active", "trialing", "past_due"].includes(subscription.status));
  const paused = Boolean(subscription && !live && ["unpaid", "incomplete", "paused"].includes(subscription.status));
  const managesBilling = Boolean(account && (!account.team || account.team.role === "owner") && !account.team?.invoiced);
  const current = live ? plans.find(plan => plan.id === subscription?.plan?.price) : undefined;
  const spaces = account?.spaceCount ?? 0;
  // What the account's plan covers, shown against its spaces before any plan is picked.
  const limit = live ? subscription?.plan?.spaces ?? null : null;
  const planName = live ? current?.name ?? account?.team?.planName ?? null : null;

  /** The button for one price, by who is looking. */
  function action(plan: Plan, label: string, variant: PricingActionProps["variant"]): PricingActionProps {
    if (account && plan.spaces !== null && plan.spaces < spaces) {
      return { label: `Covers ${spacesText(plan.spaces)}, you have ${spaces}`, variant, disabled: true };
    }
    // Pay as you go bills spaces, so it starts with adding one.
    if (!account) return { label, variant, href: `/account/signup?next=${encodeURIComponent(plan.spaces === null ? "/account" : `/account/plan?plan=${plan.id}`)}` };
    if (!managesBilling || paused) return { label, variant, href: "/account/plan" };
    if (live) return plan.id === current?.id ? { label: "Your plan", variant: "outline", href: "/account/plan" }
      : { label: `Switch to ${price(plan)}`, variant, href: `/account/plan?plan=${plan.id}` };
    if (plan.spaces === null && account.spaceCount === 0) return { label, variant, href: "/account" };
    return { label, variant, checkout: plan.id };
  }

  const hostingOffers = groupOffers(plans);
  const build = account ? "/account/tours/new" : `/account/signup?next=${encodeURIComponent("/account/tours/new")}`;
  const mail = (subject: string) => sales && <a href={`mailto:${sales}?subject=${encodeURIComponent(subject)}`}>{sales}</a>;

  function offerCard(offer: Offer) {
    const year = yearly(offer), month = monthly(offer);
    const main = year ?? offer.prices[0];
    const others = offer.prices.filter(plan => plan !== main);
    const saving = yearlySaving(offer);
    const tooSmall = Boolean(account && offer.spaces !== null && offer.spaces < spaces);
    const audience = offer.spaces === null ? "Pay only for the spaces you host" : `For ${spacesText(offer.spaces)}`;
    const features = offer.spaces === null ? [
      `${amount(main)} ${formatPeriod(main.interval, main.intervalCount)} for each space you host`,
      "A public link and an embed for every space",
      "Add or delete spaces any time, prorated on your next invoice",
      "Every player in your class results while you host"
    ] : [
      "Every player in your tours' results, with spreadsheets",
      "The agent drafts tours and hunts as often as you like",
      `Host ${spacesText(offer.spaces)} of your own, with a public link and embed`
    ];
    // Hosting cards, four to a row, keep the button short.
    const label = (plan: Plan) => offer.spaces === null ? (account?.spaceCount ? "Pay as you go" : account ? "Add a space" : "Try it free")
      : `Choose ${offer.name}`;
    return <Card key={offer.product} name={offer.name} audience={audience}
      flag={tooSmall ? `Too small for your ${spaces} spaces` : undefined} flagMuted={tooSmall}
      plan={{ amount: amount(main), period: offer.spaces === null ? `${formatPeriod(main.interval, main.intervalCount)} for each space` : formatPeriod(main.interval, main.intervalCount) }}
      alternative={others.length ? <>or {others.map(price).join(", or ")}{saving && main === year && month ? <> <span className="pricing-save">Save {saving} yearly</span></> : null}</> : undefined}
      features={features}
      actions={<>
        <PricingAction {...action(main, label(main), "ink")} />
        {others.map(plan => <PricingAction key={plan.id} {...action(plan, `Or pay ${price(plan)}`, "outline")} />)}
      </>} />;
  }

  const currency = plans[0]?.currency.toUpperCase();
  const nav = [{ href: "/learn", label: "How it works" }, { href: "/pricing", label: "Pricing", current: true },
    account ? { href: "/account", label: "Your account" } : { href: "/account/login", label: "Sign in" }];
  const policies = [{ href: "/pricing", label: "Pricing" }, { href: "/terms", label: "Terms" }, { href: "/privacy", label: "Privacy" }];

  return <div className="site"><div className="site-frame">
    <SiteHeader brand={brand} nav={nav} />
    <main className="site-main pricing">
      <div className="pricing-hero">
        <h1>Pricing</h1>
        <p>Build tours and scavenger hunts for free. Pay when you host 3D spaces of your own, and every player shows in your results.</p>
      </div>
      {account && (live || spaces > 0) && <SpaceUsage used={spaces} limit={limit} plan={planName} />}
      {live && current && <p className="site-note pricing-current" role="status">You&apos;re on {current.name} at {price(current)}. <a href="/account/plan">Manage your plan</a></p>}
      {live && !current && <p className="site-note pricing-current" role="status">Your plan is not listed here any more. You can keep it, or switch on the <a href="/account/plan">plan page</a>.</p>}

      <section className="pricing-group" aria-labelledby="teachers-title" id="teachers">
        <div className="pricing-group-head">
          <h2 id="teachers-title">Teachers and schools</h2>
          <p>Students play from a link and don&apos;t need accounts. Your first {FREE_PLAYERS} players show in your class results, and a hosting plan shows them all.</p>
        </div>
        <div className="pricing-cards" style={{ "--cards": 2 } as CSSProperties}>
          <Card name="Free" audience="For trying it with a class" plan={{ amount: formatMoney(0, plans[0]?.currency ?? "usd"), period: "forever" }}
            features={[
              `Build tours and scavenger hunts on ${brand}'s public spaces`,
              "Share them with a link, no student accounts needed",
              `Class results for your first ${FREE_PLAYERS} players`,
              ...billing ? [`The agent drafts ${FREE_AGENT_DRAFTS} tours a month`, `Your first 3D capture as a free private preview for ${previewDays()} days`] : []
            ]}
            actions={<PricingAction label="Start building free" variant="outline" href={build} />} />
          <Card name="Schools and districts" audience="For every student at a school" plan={{ amount: "Quoted", period: "by the year" }}
            features={[
              "Mused's tours, trivia and simulations for every student, with school sign-in",
              "Help from the Mused team when a school network blocks the tours",
              "Copies of the tours that run without the internet",
              `${brand} for captures of your own, as an Enterprise account`
            ]}
            actions={<PricingAction label="See Mused for Schools" variant="outline" href={schoolsUrl} />}
            note={sales ? <>Hosting your school&apos;s own captures? Email {mail("Enterprise for a school")}.</> : undefined} />
        </div>
      </section>

      {hostingOffers.length > 0 && <section className="pricing-group" aria-labelledby="hosting-title" id="hosting">
        <div className="pricing-group-head">
          <h2 id="hosting-title">Hosting your own spaces</h2>
          <p>Upload a 3D capture and host it with a public link and an embed. Your first capture is a free private preview, so you pay when you publish it or keep it.</p>
        </div>
        <div className="pricing-cards" style={{ "--cards": hostingOffers.length } as CSSProperties}>{hostingOffers.map(offerCard)}</div>
        {sales && <p className="pricing-larger">Running tours for a museum, university or company at a larger scale? Email {mail("Larger plan")} and we will set you up with a plan and an invoice.</p>}
      </section>}

      {billing && !plans.length && <p className="site-alert" role="alert">Plans can&apos;t be shown right now. Reload the page in a moment.</p>}

      <section className="pricing-faq" aria-labelledby="faq-title">
        <h2 id="faq-title">Questions</h2>
        <div>
          <h3>Do my students need accounts?</h3>
          <p>No. They open your hunt from its link and type their name, or play without one. Their progress shows in your class results.</p>
        </div>
        <div>
          <h3>What counts as a space?</h3>
          <p>A space is a 3D capture you upload, like a classroom, museum or site you scanned. Tours and hunts you build on {brand}&apos;s public spaces don&apos;t count, and you can build as many as you like.</p>
        </div>
        <div>
          <h3>How do I pay, and can I cancel?</h3>
          <p>You pay on Stripe&apos;s secure checkout page. You can cancel any time from your account, and your plan keeps working until the end of the period you paid for.</p>
        </div>
        <div>
          <h3>Is there a plan for my school?</h3>
          <p>Schools and districts get their plans through <a href={schoolsUrl}>Mused for Schools</a>, which covers Mused&apos;s tours and simulations for every student, with help when the school network gets in the way. A school that hosts captures of its own on {brand} takes an Enterprise account.{sales ? <> Email {mail("Enterprise for a school")} to set one up.</> : null}</p>
        </div>
        {sales && <div>
          <h3>Can we pay by invoice or purchase order?</h3>
          <p>Yes. Email {mail("Invoice")} with your school or organization&apos;s name, and we will set you up with an invoice.</p>
        </div>}
      </section>

      {currency && <p className="pricing-fine">Prices are in {currency === "USD" ? "US dollars" : currency}. Hosted spaces stay online until the end of the period you paid for.</p>}
    </main>
    <SiteFooter brand={brand} links={policies} />
  </div></div>;
}
