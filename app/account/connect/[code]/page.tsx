import { notFound, redirect } from "next/navigation";
import AgentConnect from "@/components/AgentConnect";
import { normalizeUserCode, readAgentLink } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { siteBrand } from "@/lib/server/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Link your agent", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

/** Where an agent sends the person to approve its code. */
export default async function ConnectPage({ params }: { params: Promise<{ code: string }> }) {
  if (!accountsEnabled()) notFound();
  const code = normalizeUserCode(decodeURIComponent((await params).code));
  const user = await currentUser();
  if (code && !user) redirect(`/account/login?next=${encodeURIComponent(`/account/connect/${code}`)}`);
  const link = code ? readAgentLink(code) : undefined;
  return <AgentConnect brand={siteBrand()} email={user?.email ?? ""} link={link ? { code: link.userCode, client: link.client, approved: link.approved } : null} />;
}
