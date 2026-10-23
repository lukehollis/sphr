import { readAllScenes } from "@/lib/scene-catalog";
import { adminResponse, isAdmin } from "@/lib/server/auth";
import { accountsEnabled, canManageScene, currentUser, publicOrigin, spaceHosted } from "@/lib/server/accounts";
import { readSpacePreview, spaceForScene } from "@/lib/server/accounts-store";
import { ExportUnavailable, spaceExport } from "@/lib/server/space-export";
import { zipLength, zipStream } from "@/lib/server/zip";

export const dynamic = "force-dynamic";

// Downloads stream from storage through this process, a few at a time, so visitors keep its bandwidth.
const limits = { site: 4, account: 2 };
const running = new Map<string, number>();
let total = 0;

const busy = (who: string) => total >= limits.site || (running.get(who) ?? 0) >= limits.account;

/** Who may download, and what: the space's owner and team (or the operator), once it is hosted. */
async function prepare(request: Request, id: string) {
  if (!/^[a-f0-9]{12}$/.test(id) || !(await canManageScene(id))) return { error: adminResponse({ error: "Sign in to continue." }, 401) } as const;
  const admin = await isAdmin();
  const space = accountsEnabled() ? spaceForScene(id) : undefined;
  // A free preview is kept by hosting it; a space whose billing lapsed after it was paid for can still be taken away.
  if (space && !admin && !spaceHosted(space) && readSpacePreview(space.id)) {
    return { error: adminResponse({ error: "Start hosting this space to download everything.", gate: "publish", plan: `/account/plan?space=${space.id}` }, 402) } as const;
  }
  const scene = (await readAllScenes()).find(item => item.sceneId === id);
  if (!scene) return { error: adminResponse({ error: "Space not found." }, 404) } as const;
  const who = admin ? "operator" : (await currentUser())?.id ?? "operator";
  try {
    return { who, download: await spaceExport(scene, publicOrigin(request)) } as const;
  } catch (error) {
    if (!(error instanceof ExportUnavailable)) throw error;
    console.error(`Unable to prepare the download of ${id}:`, error.message);
    return { error: adminResponse({ error: "This space's files are unavailable right now. Try again in a few minutes." }, 503) } as const;
  }
}

function headers(name: string, length: number | null) {
  return {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${name}.zip"`,
    ...(length === null ? {} : { "Content-Length": String(length) }),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    // Nginx passes the zip along as it is read, instead of saving it to disk ahead of a slow download.
    "X-Accel-Buffering": "no"
  };
}

/** Whether the download is ready, and how big it is, without starting it. */
export async function HEAD(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const prepared = await prepare(request, (await params).id);
  const status = prepared.error?.status ?? (busy(prepared.who!) ? 429 : 200);
  if (status !== 200) return new Response(null, { status, headers: { "Cache-Control": "private, no-store" } });
  return new Response(null, { headers: headers(prepared.download!.name, zipLength(prepared.download!.files)) });
}

/** A zip of everything that makes up a space, streamed from storage as the browser takes it. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const prepared = await prepare(request, id);
  if (prepared.error) return prepared.error;
  const { who, download } = prepared;
  if (busy(who)) {
    return adminResponse({ error: "Other downloads are still running. Try again when they finish." }, 429);
  }
  total += 1;
  running.set(who, (running.get(who) ?? 0) + 1);
  const finished = () => {
    total -= 1;
    const count = (running.get(who) ?? 1) - 1;
    if (count > 0) running.set(who, count); else running.delete(who);
  };
  const body = zipStream(download.files, {
    onClose: finished,
    onError: error => console.error(`The download of ${id} stopped:`, error instanceof Error ? error.message : error)
  });
  return new Response(body, { headers: headers(download.name, zipLength(download.files)) });
}
