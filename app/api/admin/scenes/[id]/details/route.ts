import { readSourceScenes } from "@/lib/scene-catalog";
import { parseSpaceInfo, SpaceInfoError } from "@/lib/space-info";
import { EditConflict } from "@/lib/server/admin-store";
import { adminResponse, readAdminBody } from "@/lib/server/auth";
import { canManageScene } from "@/lib/server/accounts";
import { saveSpaceInfo } from "@/lib/server/space-info";

/** Saves a space's details: description, location, who captured it and when, contact, website and credits. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await canManageScene(id))) return adminResponse({ error: "Sign in to continue." }, 401);
  let body;
  try { body = await readAdminBody(request, 16 * 1024); }
  catch { return adminResponse({ error: "Invalid request." }, 400); }
  if (!Number.isSafeInteger(body?.revision) || body.revision < 0) return adminResponse({ error: "Reload the page and try again." }, 400);
  if (!(await readSourceScenes()).some(scene => scene.sceneId === id)) return adminResponse({ error: "Space not found." }, 404);
  try {
    const saved = saveSpaceInfo(id, body.revision, parseSpaceInfo(body.info));
    return adminResponse({ ok: true, ...saved });
  } catch (error) {
    if (error instanceof SpaceInfoError) return adminResponse({ error: error.message }, 400);
    if (error instanceof EditConflict) return adminResponse({ error: error.message }, 409);
    throw error;
  }
}
