import { notFound } from "next/navigation";
import { ConfirmEmail } from "@/components/AccountAuth";
import { accountsEnabled } from "@/lib/server/accounts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Confirm email address", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  if (!accountsEnabled()) notFound();
  const token = (await searchParams).token;
  return <ConfirmEmail token={typeof token === "string" && /^[a-f0-9]{64}$/.test(token) ? token : ""} />;
}
