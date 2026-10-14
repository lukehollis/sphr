import { notFound } from "next/navigation";
import TeamJoin from "@/components/TeamJoin";
import { readTeamByJoinCode, userTeam } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { siteBrand } from "@/lib/server/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Join team", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default async function TeamJoinPage({ params }: { params: Promise<{ code: string }> }) {
  if (!accountsEnabled()) notFound();
  const { code } = await params;
  const team = readTeamByJoinCode(code);
  const user = await currentUser();
  const membership = user ? userTeam(user.id) : undefined;
  return <TeamJoin
    brand={siteBrand()}
    code={code}
    invite={team ? {
      id: team.id,
      name: team.name,
      joinCode: team.joinCode,
      joinDomain: team.joinDomain,
      planName: team.planName,
      planSpaces: team.planSpaces,
    } : null}
    user={user ? {
      email: user.email,
      emailVerified: user.emailVerified,
      alreadyMember: Boolean(team && membership?.team.id === team.id),
      otherTeamName: membership && (!team || membership.team.id !== team.id) ? membership.team.name : null,
    } : null}
  />;
}
