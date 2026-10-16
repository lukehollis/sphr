import { notFound, redirect } from "next/navigation";
import SpaceManager from "@/components/SpaceManager";
import { readUser } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser, ownedSpace } from "@/lib/server/accounts";
import { applyCheckoutSession, billingEnabled, readPlans, syncQuantity } from "@/lib/server/billing";
import { describeAccount, describeSpace } from "@/lib/server/customer-spaces";
import { siteBrand } from "@/lib/server/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Manage space", robots: { index: false, follow: false } };
const log = (label: string) => (error: unknown) => console.error(label, error instanceof Error ? error.message : error);

export default async function ManageSpacePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ checkout?: string }> }) {
  if (!accountsEnabled()) notFound();
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id)) notFound();
  const { checkout } = await searchParams;
  const session = typeof checkout === "string" && /^cs_[A-Za-z0-9_]{1,200}$/.test(checkout) ? checkout : undefined;
  if (!(await currentUser())) redirect(`/account/login?next=${encodeURIComponent(`/account/spaces/${id}${session ? `?checkout=${session}` : ""}`)}`);
  // Paying from a free preview's page returns here. Returning usually beats the webhook, so apply the payment now.
  if (session && billingEnabled()) {
    const user = await currentUser();
    if (user) {
      await applyCheckoutSession(session, user.id).catch(log("Unable to apply Checkout:"));
      await syncQuantity(user.id).catch(log("Unable to update the subscription quantity:"));
    }
  }
  const owned = await ownedSpace(id);
  if (!owned) notFound();
  const view = await describeSpace(owned.space);
  const notice = session && view.hosted ? "Payment received. This space is hosted now. Make it public whenever you are ready to share it." : undefined;
  return <SpaceManager brand={siteBrand()} space={view} account={describeAccount(readUser(owned.user.id)!)} plans={await readPlans()} notice={notice} fromCheckout={Boolean(session)} />;
}
