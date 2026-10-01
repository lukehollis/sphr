import { notFound, redirect } from "next/navigation";
import AccountDashboard from "@/components/AccountDashboard";
import { listAgentTokens, listCustomerSpaces, readSubscription, readUser } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { applyCheckoutSession, billingEnabled, readPlans, syncQuantity, syncSubscription } from "@/lib/server/billing";
import { describeAccount, describeSpace } from "@/lib/server/customer-spaces";
import { siteBrand } from "@/lib/server/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your spaces", robots: { index: false, follow: false } };
const log = (label: string) => (error: unknown) => console.error(label, error instanceof Error ? error.message : error);

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ checkout?: string; verified?: string; agent?: string }> }) {
  if (!accountsEnabled()) notFound();
  const user = await currentUser();
  const params = await searchParams;
  // Someone who paid in another browser signs in there and still lands on the payment's result.
  if (!user) redirect(typeof params.checkout === "string" && /^cs_[A-Za-z0-9_]{1,200}$/.test(params.checkout)
    ? `/account/login?next=${encodeURIComponent(`/account?checkout=${params.checkout}${params.agent === "1" ? "&agent=1" : ""}`)}` : "/account/login");
  if (billingEnabled()) {
    // Returning from Checkout usually beats the webhook; apply the result now.
    if (typeof params.checkout === "string") await applyCheckoutSession(params.checkout, user.id).catch(log("Unable to apply Checkout:"));
    // Subscriptions saved before plans existed learn their plan once.
    const subscription = readSubscription(user.id);
    if (subscription && !subscription.plan) await syncSubscription(subscription.id).catch(log("Unable to read the subscription:"));
    // Repairs a quantity left behind by an earlier failed update.
    await syncQuantity(user.id).catch(log("Unable to update the subscription quantity:"));
  }
  const notice = params.verified === "1" ? "Email address confirmed." : params.verified === "0" ? "That confirmation link has expired. Send a new one below."
    : params.checkout && params.agent === "1" ? "Payment received. Your agent can upload the files now."
    : params.checkout ? "Payment received. Add your files to each space." : undefined;
  const fresh = readUser(user.id)!;
  const spaces = await Promise.all(listCustomerSpaces(fresh.id).map(describeSpace));
  return <AccountDashboard brand={siteBrand()} account={describeAccount(fresh)} spaces={spaces} plans={await readPlans()} notice={notice}
    fromCheckout={typeof params.checkout === "string"} agents={listAgentTokens(fresh.id)} />;
}
