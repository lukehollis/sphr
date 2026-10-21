import { readSourceScenes } from "@/lib/scene-catalog";
import { parseSpaceTags, SpaceTagError } from "@/lib/space-tags";
import { EditConflict } from "@/lib/server/admin-store";
import { adminResponse, readAdminBody } from "@/lib/server/auth";
import { canManageScene } from "@/lib/server/accounts";
import { saveSpaceTags } from "@/lib/server/space-tags";

/** Saves a space's tags: the whole list, or null to show the tags its capture came with again. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await canManageScene(id))) return adminResponse({ error: "Sign in to continue." }, 401);
  let body;
  try { body = await readAdminBody(request, 2 * 1024 * 1024); }
  catch { return adminResponse({ error: "Invalid request." }, 400); }
  if (!Number.isSafeInteger(body?.revision) || body.revision < 0) return adminResponse({ error: "Reload the page and try again." }, 400);
  if (!(await readSourceScenes()).some(scene => scene.sceneId === id)) return adminResponse({ error: "Space not found." }, 404);
  try {
    const saved = saveSpaceTags(id, body.revision, body.tags === null ? null : parseSpaceTags(body.tags));
    return adminResponse({ ok: true, ...saved });
  } catch (error) {
    if (error instanceof SpaceTagError) return adminResponse({ error: error.message }, 400);
    if (error instanceof EditConflict) return adminResponse({ error: error.message }, 409);
    throw error;
  }
}
