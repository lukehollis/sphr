import { notFound, redirect } from "next/navigation";
import PlanPage from "@/components/PlanPage";
import { readSubscription, readUser } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { billingEnabled, readPlans, syncSubscription } from "@/lib/server/billing";
import { describeAccount } from "@/lib/server/customer-spaces";
import { siteBrand } from "@/lib/server/brand";
import { buildReturnPath, readyToBuild } from "@/lib/server/user-tours";

export const dynamic = "force-dynamic";
export const metadata = { title: "Plan", robots: { index: false, follow: false } };

export default async function AccountPlanPage({ searchParams }: { searchParams: Promise<{ build?: string }> }) {
  if (!accountsEnabled() || !billingEnabled()) notFound();
  const raw = (await searchParams).build;
  // Choosing a plan on the way to building a tour, on one space (its id) or any ("1").
  const build = typeof raw === "string" && /^(?:[a-f0-9]{12}|1)$/.test(raw) ? raw : undefined;
  const user = await currentUser();
  if (!user) redirect(`/account/login?next=${encodeURIComponent(build ? `/account/plan?build=${build}` : "/account/plan")}`);
  if (build && readyToBuild(user.id)) redirect(buildReturnPath(build));
  const subscription = readSubscription(user.id);
  if (subscription && !subscription.plan) {
    await syncSubscription(subscription.id).catch(error => console.error("Unable to read the subscription:", error instanceof Error ? error.message : error));
  }
  return <PlanPage brand={siteBrand()} account={describeAccount(readUser(user.id)!)} plans={await readPlans()} build={build} />;
}
