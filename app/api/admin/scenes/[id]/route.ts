import { readAllScenes } from "@/lib/scene-catalog";
import { isScenePublic, setSceneBuilders, setScenePublic } from "@/lib/server/admin-store";
import { openToBuilders } from "@/lib/server/user-tours";
import { adminResponse, readAdminBody } from "@/lib/server/auth";
import { canManageScene } from "@/lib/server/accounts";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await canManageScene(id))) return adminResponse({ error: "Sign in to continue." }, 401);
  let body;
  try { body = await readAdminBody(request); } catch { return adminResponse({ error: "Invalid request." }, 400); }
  if (typeof body?.public !== "boolean" && typeof body?.builders !== "boolean") return adminResponse({ error: "Choose public or private." }, 400);
  if (!(await readAllScenes()).some(scene => scene.sceneId === id)) return adminResponse({ error: "Space not found." }, 404);
  if (typeof body.public === "boolean") setScenePublic(id, body.public);
  if (typeof body.builders === "boolean") setSceneBuilders(id, body.builders);
  return adminResponse({ ok: true, public: isScenePublic(id), builders: openToBuilders(id) });
}
