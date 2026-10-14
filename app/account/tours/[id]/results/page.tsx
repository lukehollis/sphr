import { notFound, redirect } from "next/navigation";
import ClassResults from "@/components/ClassResults";
import { readUser, sameTeam } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { applyCheckoutSession, billingEnabled } from "@/lib/server/billing";
import { describeAccount } from "@/lib/server/customer-spaces";
import { siteBrand } from "@/lib/server/brand";
import { allPlayersShown, askingNames, FREE_PLAYERS, listPlays, playMinutes, playProgress } from "@/lib/server/tour-plays";
import { readUserTour, tourPath } from "@/lib/server/user-tours";

export const dynamic = "force-dynamic";
export const metadata = { title: "Class results", robots: { index: false, follow: false } };

/** Who played the owner's shared tour or hunt and how far each got (lib/server/tour-plays.ts). */
export default async function TourResultsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ checkout?: string }> }) {
  if (!accountsEnabled()) notFound();
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id)) notFound();
  const user = await currentUser();
  if (!user) redirect(`/account/login?next=${encodeURIComponent(`/account/tours/${id}/results`)}`);
  const tour = readUserTour(id);
  if (!tour || !sameTeam(tour.userId, user.id)) notFound();
  // Back from choosing a plan: Checkout usually beats the webhook, so its result is applied now.
  const { checkout } = await searchParams;
  if (typeof checkout === "string" && billingEnabled()) {
    await applyCheckoutSession(checkout, user.id).catch(error => console.error("Unable to apply Checkout:", error instanceof Error ? error.message : error));
  }
  const plays = listPlays(tour.id);
  const all = allPlayersShown(user.id);
  const shown = all ? plays : plays.slice(0, FREE_PLAYERS);
  return <ClassResults brand={siteBrand()} account={describeAccount(readUser(user.id)!)}
    tour={{ id: tour.id, title: tour.title, kind: tour.kind, public: tour.public, path: tourPath(tour) }}
    asking={askingNames(tour.id)} players={plays.length} finished={plays.filter(play => play.finished).length}
    rows={shown.map(play => ({ id: play.id, name: play.name, started: play.started, progress: playProgress(play, tour.kind),
      finished: Boolean(play.finished), time: playMinutes(play.seconds) }))}
    hidden={plays.length - shown.length} all={all} paid={typeof checkout === "string" && all} />;
}
