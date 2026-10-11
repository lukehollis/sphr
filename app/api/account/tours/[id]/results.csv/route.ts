import { accountResponse, publicOrigin } from "@/lib/server/accounts";
import { allPlayersShown, listPlays, playMinutes, playProgress } from "@/lib/server/tour-plays";
import { ownedTourRequest } from "@/lib/server/user-tours";

/** Every player of the owner's tour as a spreadsheet, on a plan. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, tour, error } = await ownedTourRequest(request, (await params).id, 0, { body: "none", anySpace: true });
  if (error) return error;
  if (!allPlayersShown(user.id)) {
    const plan = `${publicOrigin(request)}/account/plan`;
    return accountResponse({ error: `Downloading class results comes with a plan. Choose one at ${plan}`, plan }, 402);
  }
  // A cell starting with = + - @ is read as a formula by spreadsheets, so names never start with one.
  const cell = (value: string) => `"${value.replace(/^[=+\-@\t\r]+/, "").replaceAll('"', '""')}"`;
  const rows = [["Name", "Started", "Progress", "Finished", "Time"].map(cell).join(",")];
  for (const play of listPlays(tour.id)) {
    rows.push([play.name || "No name", play.started.slice(0, 16).replace("T", " ") + " UTC", playProgress(play, tour.kind),
      play.finished ? "Yes" : "No", playMinutes(play.seconds)].map(cell).join(","));
  }
  const filename = `${tour.title.replace(/[^\w -]+/g, "").trim().slice(0, 60) || "tour"} class results.csv`;
  return new Response(rows.join("\r\n") + "\r\n", { headers: { "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" } });
}
