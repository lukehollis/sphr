import { notFound } from "next/navigation";
import PolicyPage from "@/components/site/PolicyPage";
import { accountsEnabled } from "@/lib/server/accounts";
import { salesEmail, siteBrand } from "@/lib/server/brand";
import { billingEnabled, readPlans } from "@/lib/server/billing";
import { previewDays, previewLimits } from "@/lib/server/previews";
import { FREE_PLAYERS } from "@/lib/server/tour-plays";
import { formatBytes } from "@/lib/bytes";
import { formatMoney, formatPeriod } from "@/lib/price";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Pricing",
  description: "Tours and scavenger hunts are free. Your first space is a free private preview. You pay to publish a space or to see every player in your class results."
};

/** What it costs, read from Stripe so the page can never disagree with the plan choice at checkout. */
export default async function PricingPage() {
  if (!accountsEnabled()) notFound();
  const plans = billingEnabled() ? await readPlans() : [];
  const limits = previewLimits();
  const sales = salesEmail();
  const classroom = plans.some(plan => plan.name === "Classroom");
  const sections = [
    { id: "free", title: "Free", body: <>
      <p>Tours and scavenger hunts are free for every account, on Spacery&apos;s public spaces and on your own. There is no card to add.</p>
      {billingEnabled() && <p>Your first space is a free preview. Upload one capture of up to {limits.files} files and {formatBytes(limits.bytes)}, see the result, and open it privately for {previewDays()} days after it is ready. Nothing is billed for a preview.</p>}
      <p>Class results show your first {FREE_PLAYERS} players for free.</p>
    </> },
    ...(plans.length ? [{ id: "hosting", title: "Hosting", body: <>
      <p>To make a space public, embed it or keep it after its preview, you start hosting. You can pay for each space as you go, or choose a plan that covers several spaces for one price.</p>
      <ul>{plans.map(plan => <li key={plan.id}>{plan.name}, {formatMoney(plan.amount, plan.currency)} {formatPeriod(plan.interval, plan.intervalCount)}
        {plan.spaces === null ? " for each space" : `, up to ${plan.spaces} ${plan.spaces === 1 ? "space" : "spaces"}`}</li>)}</ul>
      <p>Prices are in US dollars. Hosting is billed through Stripe and you can cancel any time. Your spaces stay online until the end of the period you paid for.</p>
    </> },
    { id: "teachers", title: "Teachers and schools", body: <>
      <p>Building and sharing a scavenger hunt costs nothing. Any plan shows every player in your class results and gives you a spreadsheet of them.{classroom ? " Classroom is the smallest plan and is made for one teacher. It comes monthly or yearly, so you can pay for a single unit and cancel." : ""}</p>
      <p>Everyone on a team shares the team&apos;s plan, so one plan can cover every teacher at a school.</p>
    </> }] : []),
    ...(sales ? [{ id: "larger", title: "Larger teams", body: <p>Running tours for a museum, university or company at a larger scale? Email <a href={`mailto:${sales}?subject=${encodeURIComponent("Larger plan")}`}>{sales}</a> and we will set you up with a plan and an invoice.</p> }] : [])
  ];
  return <PolicyPage brand={siteBrand()} code="P" title="Pricing" lede={<>Free to start. You pay when you publish a space or want every player in your class results.</>} sections={sections} />;
}
