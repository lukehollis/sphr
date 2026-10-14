import { notFound, redirect } from "next/navigation";
import TeamPage from "@/components/TeamPage";
import { listTeams, readUser, userTeam } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser, publicOrigin } from "@/lib/server/accounts";
import { isAdmin } from "@/lib/server/auth";
import { describeAccount } from "@/lib/server/customer-spaces";
import { siteBrand } from "@/lib/server/brand";
import { operatorAccount } from "@/lib/server/profiles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team", robots: { index: false, follow: false } };

export default async function AccountTeamPage() {
  if (!accountsEnabled()) notFound();
  const user = await currentUser();
  if (!user) redirect(`/account/login?next=${encodeURIComponent("/account/team")}`);
  const fresh = readUser(user.id)!;
  const membership = userTeam(fresh.id);
  const operator = operatorAccount() === fresh.id || await isAdmin();
  return <TeamPage
    brand={siteBrand()}
    origin={publicOrigin()}
    userId={fresh.id}
    account={describeAccount(fresh)}
    team={membership?.team ?? null}
    role={membership?.role ?? null}
    operator={operator}
    allTeams={operator ? listTeams() : []}
  />;
}
