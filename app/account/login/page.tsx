import { notFound, redirect } from "next/navigation";
import AccountAuth from "@/components/AccountAuth";
import { accountsEnabled, currentUser, safeReturnPath } from "@/lib/server/accounts";
import { mailConfigured } from "@/lib/server/mail";
import { enabledProviders } from "@/lib/server/oauth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in", robots: { index: false, follow: false } };

export default async function AccountLoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  if (!accountsEnabled()) notFound();
  const params = await searchParams;
  const returnPath = safeReturnPath(params.next);
  if (await currentUser()) redirect(returnPath);
  return <AccountAuth mode="login" providers={enabledProviders()} passwordEnabled={mailConfigured()} returnPath={returnPath}
    error={typeof params.error === "string" ? params.error : undefined} />;
}
