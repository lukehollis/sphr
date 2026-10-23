import { notFound, redirect } from "next/navigation";
import { ImportStart } from "@/components/MatterportImport";
import { readSubscription, readUser } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { readPlans } from "@/lib/server/billing";
import { describeAccount } from "@/lib/server/customer-spaces";
import { importDaily, importMaxLinks, listImports, summarizeImport } from "@/lib/server/imports";
import { siteBrand } from "@/lib/server/brand";
import { formatMoney, formatPeriod } from "@/lib/price";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bring over Matterport spaces", robots: { index: false, follow: false } };

/** What the spaces of a list cost, as the add-a-space sheet says it for one space. */
async function priceHint(userId: string, account: ReturnType<typeof describeAccount>) {
  if (!account.billing) return undefined;
  const plans = await readPlans().catch(() => []);
  const perSpace = plans.find(plan => plan.spaces === null);
  const price = perSpace && `${formatMoney(perSpace.amount, perSpace.currency)} ${formatPeriod(perSpace.interval, perSpace.intervalCount)}`;
  const subscription = readSubscription(userId);
  const hosting = subscription && ["active", "trialing", "past_due"].includes(subscription.status);
  if (!hosting) return account.preview?.available
    ? `The first is your free private preview, opened for you before you pay anything. The others come over once hosting starts${price ? `, at ${price} for each space or on a plan that covers them` : ""}.`
    : `They come over once hosting starts${price ? `, at ${price} for each space or on a plan that covers them` : ""}.`;
  const covers = subscription.plan?.spaces ?? null;
  if (covers !== null) return `Your plan covers ${covers} spaces and you have ${account.spaceCount}. Spaces past that wait until you change plans.`;
  const amount = subscription.plan?.amount;
  return amount ? `Each space adds ${formatMoney(amount, subscription.plan!.currency)} ${formatPeriod(subscription.plan!.interval, subscription.plan!.intervalCount)} as it comes over, prorated for this period.` : undefined;
}

export default async function ImportPage() {
  if (!accountsEnabled()) notFound();
  const user = await currentUser();
  if (!user) redirect(`/account/login?next=${encodeURIComponent("/account/import")}`);
  const account = describeAccount(readUser(user.id)!);
  return <ImportStart brand={siteBrand()} account={account} imports={listImports(user.id).map(summarizeImport)} maxLinks={importMaxLinks()}
    daily={importDaily()} hint={await priceHint(user.id, account)} />;
}
