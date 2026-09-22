import { notFound } from "next/navigation";
import { ResetPassword } from "@/components/AccountAuth";
import { accountsEnabled } from "@/lib/server/accounts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Choose a new password", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  if (!accountsEnabled()) notFound();
  const token = (await searchParams).token;
  return <ResetPassword token={typeof token === "string" && /^[a-f0-9]{64}$/.test(token) ? token : ""} />;
}
