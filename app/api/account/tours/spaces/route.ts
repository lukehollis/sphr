import { accountResponse } from "@/lib/server/accounts";
import { buildableSpaces, tourUser } from "@/lib/server/user-tours";

/** Spaces the customer can build tours on: their own finished spaces and Spacery's, matching an optional search. */
export async function GET(request: Request) {
  const { user, error } = await tourUser(request);
  if (error) return error;
  const url = new URL(request.url);
  const terms = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 40) || 40));
  const match = (title: string) => terms.every((term) => title.toLowerCase().includes(term));
  const { own, spacery } = await buildableSpaces(user.id);
  const describe = (whose: "own" | "spacery") => (space: (typeof own)[number]) => ({ sceneId: space.sceneId, title: space.title, locations: space.nodeCount, whose });
  return accountResponse({ spaces: [...own.filter((space) => match(space.title)).map(describe("own")), ...spacery.filter((space) => match(space.title)).map(describe("spacery"))].slice(0, limit) });
}
