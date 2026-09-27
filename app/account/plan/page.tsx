import { notFound, redirect } from "next/navigation";
import PlanPage from "@/components/PlanPage";
import { readSubscription, readUser } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { billingEnabled, readPlans, syncSubscription } from "@/lib/server/billing";
import { describeAccount } from "@/lib/server/customer-spaces";
import { siteBrand } from "@/lib/server/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Plan", robots: { index: false, follow: false } };

export default async function AccountPlanPage() {
  if (!accountsEnabled() || !billingEnabled()) notFound();
  const user = await currentUser();
  if (!user) redirect(`/account/login?next=${encodeURIComponent("/account/plan")}`);
  const subscription = readSubscription(user.id);
  if (subscription && !subscription.plan) {
    await syncSubscription(subscription.id).catch(error => console.error("Unable to read the subscription:", error instanceof Error ? error.message : error));
  }
  return <PlanPage brand={siteBrand()} account={describeAccount(readUser(user.id)!)} plans={await readPlans()} />;
}
