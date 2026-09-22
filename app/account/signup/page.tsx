import { notFound, redirect } from "next/navigation";
import AccountAuth from "@/components/AccountAuth";
import { accountsEnabled, currentUser, safeReturnPath } from "@/lib/server/accounts";
import { mailConfigured } from "@/lib/server/mail";
import { enabledProviders } from "@/lib/server/oauth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create account", robots: { index: false, follow: false } };

export default async function AccountSignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!accountsEnabled()) notFound();
  const returnPath = safeReturnPath((await searchParams).next);
  if (await currentUser()) redirect(returnPath);
  return <AccountAuth mode="signup" providers={enabledProviders()} passwordEnabled={mailConfigured()} returnPath={returnPath} />;
}
