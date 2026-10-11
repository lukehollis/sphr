import { accountResponse } from "@/lib/server/accounts";
import { deletePlays, setAskingNames } from "@/lib/server/tour-plays";
import { ownedTourRequest } from "@/lib/server/user-tours";

type Params = { params: Promise<{ id: string }> };

/** Whether the tour asks its players for their names (`{ asking: boolean }`). Only from the browser. */
export async function PATCH(request: Request, { params }: Params) {
  const { body, tour, error } = await ownedTourRequest(request, (await params).id, 1024, { anySpace: true, agents: false });
  if (error) return error;
  if (typeof body?.asking !== "boolean") return accountResponse({ error: "Invalid request." }, 400);
  setAskingNames(tour.id, body.asking);
  return accountResponse({ ok: true, asking: body.asking });
}

/** Deletes the tour's class results. Only from the browser. */
export async function DELETE(request: Request, { params }: Params) {
  const { tour, error } = await ownedTourRequest(request, (await params).id, 1024, { anySpace: true, agents: false });
  if (error) return error;
  deletePlays(tour.id);
  return accountResponse({ ok: true });
}
