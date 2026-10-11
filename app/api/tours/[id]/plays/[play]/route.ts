import { adminResponse, readAdminBody } from "@/lib/server/auth";
import { updatePlay } from "@/lib/server/tour-plays";
import { readUserTour, tourAccess } from "@/lib/server/user-tours";

export const dynamic = "force-dynamic";

/** A player's progress (finds, the stop reached, the finish and the seconds spent), sent as it changes. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; play: string }> }) {
  let body;
  try { body = await readAdminBody(request, 1024); } catch { return adminResponse({ error: "Invalid request." }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return adminResponse({ error: "Invalid request." }, 400);
  const { id, play } = await params;
  const tour = readUserTour(id);
  if (!tour || await tourAccess(tour) !== "allowed") return adminResponse({ error: "Tour not found." }, 404);
  return updatePlay(tour.id, play, body) ? adminResponse({ ok: true }) : adminResponse({ error: "Play not found." }, 404);
}
