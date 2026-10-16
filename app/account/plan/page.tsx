import { notFound, redirect } from "next/navigation";
import PlanPage from "@/components/PlanPage";
import { readCustomerSpace, readSubscription, readUser, sameTeam } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { billingEnabled, readPlans, syncSubscription } from "@/lib/server/billing";
import { describeAccount } from "@/lib/server/customer-spaces";
import { spacePreview } from "@/lib/server/previews";
import { siteBrand } from "@/lib/server/brand";
import { agentUnlimited, buildReturnPath, readUserTour } from "@/lib/server/user-tours";
import { allPlayersShown } from "@/lib/server/tour-plays";

export const dynamic = "force-dynamic";
export const metadata = { title: "Plan", robots: { index: false, follow: false } };

export default async function AccountPlanPage({ searchParams }: { searchParams: Promise<{ build?: string; results?: string; space?: string }> }) {
  if (!accountsEnabled() || !billingEnabled()) notFound();
  const query = await searchParams;
  const raw = query.build;
  // Choosing a plan for the tour agent while building, on one space (its id) or any ("1").
  const build = typeof raw === "string" && /^(?:[a-f0-9]{12}|1)$/.test(raw) ? raw : undefined;
  const user = await currentUser();
  // Choosing a plan to publish a space, or keep it, after its free preview.
  const spaceId = typeof query.space === "string" && /^[a-f0-9]{12}$/.test(query.space) ? query.space : undefined;
  // Choosing a plan to see every player of one of the customer's tours (lib/server/tour-plays.ts).
  const results = typeof query.results === "string" && /^[a-f0-9]{12}$/.test(query.results) ? query.results : undefined;
  if (!user) redirect(`/account/login?next=${encodeURIComponent(results ? `/account/plan?results=${results}` : build ? `/account/plan?build=${build}` : spaceId ? `/account/plan?space=${spaceId}` : "/account/plan")}`);
  const tour = results ? readUserTour(results) : undefined;
  const resultsTour = tour && sameTeam(tour.userId, user.id) ? results : undefined;
  if (resultsTour && allPlayersShown(user.id)) redirect(`/account/tours/${resultsTour}/results`);
  if (build && agentUnlimited(user.id)) redirect(buildReturnPath(build));
  const subscription = readSubscription(user.id);
  if (subscription && !subscription.plan) {
    await syncSubscription(subscription.id).catch(error => console.error("Unable to read the subscription:", error instanceof Error ? error.message : error));
  }
  const account = describeAccount(readUser(user.id)!);
  const plans = await readPlans();
  // For class results before any space, only the plans that show every player: pay as you go bills nothing yet.
  const offered = resultsTour && account.spaceCount === 0 ? plans.filter(plan => plan.spaces !== null) : plans;
  const owned = spaceId ? readCustomerSpace(spaceId) : undefined;
  const mine = owned && owned.status !== "deleted" && sameTeam(owned.userId, user.id) ? owned : undefined;
  const preview = mine ? spacePreview(mine) : null;
  const forSpace = mine && !resultsTour && !build ? { id: mine.id, title: mine.title, until: preview?.until ?? null, expired: Boolean(preview?.expired) } : undefined;
  return <PlanPage brand={siteBrand()} account={account} plans={offered} build={resultsTour ? undefined : build} results={resultsTour} forSpace={forSpace} />;
}
