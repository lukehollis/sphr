import { cleanText } from "@/lib/server/accounts-store";
import { accountsEnabled } from "@/lib/server/accounts";
import { workerAuthorized, workerResponse } from "@/lib/server/worker";
import { reportWorkerHealth } from "@/lib/server/worker-watch";

export const dynamic = "force-dynamic";

/** A worker's own check, every few minutes: `{ worker, problem }`, with problem null when it can start agents. */
export async function POST(request: Request) {
  if (!accountsEnabled() || !workerAuthorized(request)) return workerResponse({ error: "Unauthorized." }, 401);
  let body;
  try {
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("Invalid content type");
    const text = await request.text();
    if (text.length > 4096) throw new Error("Body too large");
    body = JSON.parse(text);
  } catch { return workerResponse({ error: "Invalid request." }, 400); }
  const notice = reportWorkerHealth(cleanText(body?.worker, 100) ?? "worker", cleanText(body?.problem, 1000));
  return workerResponse({ ok: true, notice });
}
