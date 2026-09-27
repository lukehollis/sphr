import { notFound, redirect } from "next/navigation";
import AccountDashboard from "@/components/AccountDashboard";
import { listCustomerSpaces, readUser } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { applyCheckoutSession, billingEnabled, readPrice, syncQuantity } from "@/lib/server/billing";
import { describeAccount, describeSpace } from "@/lib/server/customer-spaces";
import { siteBrand } from "@/lib/server/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your spaces", robots: { index: false, follow: false } };
const log = (label: string) => (error: unknown) => console.error(label, error instanceof Error ? error.message : error);

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ checkout?: string; verified?: string }> }) {
  if (!accountsEnabled()) notFound();
  const user = await currentUser();
  if (!user) redirect("/account/login");
  const params = await searchParams;
  if (billingEnabled()) {
    // Returning from Checkout usually beats the webhook; apply the result now.
    if (typeof params.checkout === "string") await applyCheckoutSession(params.checkout, user.id).catch(log("Unable to apply Checkout:"));
    // Repairs a quantity left behind by an earlier failed update.
    await syncQuantity(user.id).catch(log("Unable to update the subscription quantity:"));
  }
  const notice = params.verified === "1" ? "Email address confirmed." : params.verified === "0" ? "That confirmation link has expired. Send a new one below."
    : params.checkout ? "Payment received. Add your files to each space." : undefined;
  const fresh = readUser(user.id)!;
  const spaces = await Promise.all(listCustomerSpaces(fresh.id).map(describeSpace));
  return <AccountDashboard brand={siteBrand()} account={describeAccount(fresh)} spaces={spaces} price={await readPrice()} notice={notice}
    fromCheckout={typeof params.checkout === "string"} />;
}
