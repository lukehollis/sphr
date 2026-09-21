import { readSourceScenes } from '@/lib/scene-catalog';
import { editedListing, validateStartView } from '@/lib/scene-edits';
import { EditConflict, saveSceneEdits } from '@/lib/server/admin-store';
import { adminResponse, isAdmin, readAdminBody } from '@/lib/server/auth';
import { decodeThumbnail, readSceneBootstrap } from '@/lib/server/scene-editor';

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return adminResponse({ error: 'Sign in to continue.' }, 401);
  let body;
  try { body = await readAdminBody(request, 1024 * 1024); }
  catch { return adminResponse({ error: 'Invalid request or thumbnail too large.' }, 400); }
  if (!body || !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.title !== 'string'
    || !body.title.trim() || body.title.length > 200 || /[\u0000-\u001f\u007f]/.test(body.title)) {
    return adminResponse({ error: 'Enter a title of 1–200 characters.' }, 400);
  }
  const { id } = await params;
  const scene = (await readSourceScenes()).find(scene => scene.sceneId === id);
  if (!scene) return adminResponse({ error: 'Space not found.' }, 404);
  try {
    let capture;
    if (body.capture === null) capture = null;
    else if (body.capture !== undefined) {
      const bootstrap = await readSceneBootstrap(scene);
      capture = { view: validateStartView(body.capture?.view, bootstrap), thumbnail: await decodeThumbnail(body.capture?.thumbnail) };
    }
    const title = body.title.trim();
    const edits = saveSceneEdits(id, body.revision, title === scene.title ? null : title, capture);
    return adminResponse({ ok: true, edits, scene: editedListing(scene, edits) });
  } catch (error) {
    return adminResponse({ error: error instanceof Error ? error.message : 'Unable to save.' }, error instanceof EditConflict ? 409 : 400);
  }
}
