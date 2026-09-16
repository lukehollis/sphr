import { readAllScenes } from "@/lib/scene-catalog";
import { setScenePublic } from "@/lib/server/admin-store";
import { adminResponse, isAdmin, readAdminBody } from "@/lib/server/auth";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return adminResponse({ error: "Sign in to continue." }, 401);
  let body;
  try { body = await readAdminBody(request); } catch { return adminResponse({ error: "Invalid request." }, 400); }
  if (typeof body?.public !== "boolean") return adminResponse({ error: "Choose public or private." }, 400);
  const { id } = await params;
  if (!(await readAllScenes()).some(scene => scene.sceneId === id)) return adminResponse({ error: "Space not found." }, 404);
  setScenePublic(id, body.public);
  return adminResponse({ ok: true, public: body.public });
}
