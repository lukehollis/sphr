import { notFound, redirect } from "next/navigation";
import { ImportProgress } from "@/components/MatterportImport";
import { readUser, sameTeam } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { applyCheckoutSession, billingEnabled, syncQuantity } from "@/lib/server/billing";
import { describeAccount } from "@/lib/server/customer-spaces";
import { advanceImports, describeImport, freshenImports, readImport } from "@/lib/server/imports";
import { siteBrand } from "@/lib/server/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Matterport spaces coming over", robots: { index: false, follow: false } };
const log = (label: string) => (error: unknown) => console.error(label, error instanceof Error ? error.message : error);

export default async function ImportProgressPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ checkout?: string }> }) {
  if (!accountsEnabled()) notFound();
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id)) notFound();
  const { checkout } = await searchParams;
  const session = typeof checkout === "string" && /^cs_[A-Za-z0-9_]{1,200}$/.test(checkout) ? checkout : undefined;
  const user = await currentUser();
  if (!user) redirect(`/account/login?next=${encodeURIComponent(`/account/import/${id}${session ? `?checkout=${session}` : ""}`)}`);
  const list = readImport(id);
  if (!list || !sameTeam(list.userId, user.id)) notFound();
  // Checkout returns here, usually before the webhook: apply the payment now, so the waiting spaces start at once.
  if (session && billingEnabled()) {
    await applyCheckoutSession(session, user.id).catch(log("Unable to apply Checkout:"));
    await syncQuantity(user.id).catch(log("Unable to update the subscription quantity:"));
    await advanceImports(list.userId).catch(log("Unable to move an import:"));
  } else if (!list.finished) await freshenImports(list.userId).catch(log("Unable to move an import:"));
  return <ImportProgress brand={siteBrand()} account={describeAccount(readUser(user.id)!)} initial={describeImport(readImport(id)!)}
    notice={session ? "Payment received. The waiting spaces start coming over now." : undefined} />;
}
