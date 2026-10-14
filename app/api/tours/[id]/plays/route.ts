import { adminResponse, readAdminBody } from "@/lib/server/auth";
import { attemptKey, clientAddress, currentUser } from "@/lib/server/accounts";
import { allowAttempt } from "@/lib/server/admin-store";
import { readUser, sameTeam } from "@/lib/server/accounts-store";
import { notifyTeam } from "@/lib/server/team-notify";
import { askingNames, playerName, startPlay } from "@/lib/server/tour-plays";
import { readUserTour, tourAccess } from "@/lib/server/user-tours";

export const dynamic = "force-dynamic";

/**
 * A player starts a shared tour or scavenger hunt, with the name they typed or none, for its
 * owner's class results (lib/server/tour-plays.ts). Answers `play: null` when nothing is kept:
 * for the owner trying their own tour, and on tours that don't ask for names.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let body;
  try { body = await readAdminBody(request, 1024); } catch { return adminResponse({ error: "Invalid request." }, 400); }
  const tour = readUserTour((await params).id);
  if (!tour || await tourAccess(tour) !== "allowed") return adminResponse({ error: "Tour not found." }, 404);
  const user = await currentUser();
  if ((user && sameTeam(user.id, tour.userId)) || !askingNames(tour.id)) return adminResponse({ play: null });
  if (!allowAttempt([[attemptKey("play", clientAddress(request)), 120], [`play-tour:${tour.id}`, 2000]], 60 * 60 * 1000)) {
    return adminResponse({ error: "Too many players from here. Try again in a while." }, 429);
  }
  const { id, first } = startPlay(tour.id, playerName(body?.name));
  if (first) void notifyTeam({ title: tour.kind === "hunt" ? "Players started a scavenger hunt" : "Players started a tour",
    fields: [["Tour", tour.title], ["Account", readUser(tour.userId)?.email ?? "-"]] });
  return adminResponse({ play: id });
}
