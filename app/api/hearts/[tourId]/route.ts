import { accountRequest, accountResponse } from "@/lib/server/accounts";
import { setHeart } from "@/lib/server/profiles";
import { readUserTour, tourAccess } from "@/lib/server/user-tours";
import { recordEvent } from "@/lib/server/analytics";

type Params = { params: Promise<{ tourId: string }> };

async function change(request: Request, { params }: Params, on: boolean) {
  const { user, error } = await accountRequest(request, 256);
  if (error) return error;
  const tour = readUserTour((await params).tourId);
  if (!tour || await tourAccess(tour) !== "allowed") return accountResponse({ error: "Tour not found." }, 404);
  const hearts = setHeart(user.id, tour.id, on);
  if (on) void recordEvent("tour_hearted", { userId: user.id, props: { tour: tour.id } });
  return accountResponse({ ok: true, hearted: on, hearts });
}

/** Hearts a tour. */
export const PUT = (request: Request, context: Params) => change(request, context, true);
/** Takes a heart back. */
export const DELETE = (request: Request, context: Params) => change(request, context, false);
