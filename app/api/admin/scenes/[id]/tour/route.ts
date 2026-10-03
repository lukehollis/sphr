import { readSourceScenes } from '@/lib/scene-catalog';
import { ExperienceError } from '@/lib/experience/validate';
import { EditConflict, saveSceneTour } from '@/lib/server/admin-store';
import { adminResponse, readAdminBody } from '@/lib/server/auth';
import { canEditTour } from '@/lib/server/tour-access';
import { parseExperienceFor } from '@/lib/server/tour-requests';

/** Save a space's tour or scavenger hunt, or remove it with `experience: null`. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id) || !(await canEditTour(id))) return adminResponse({ error: 'Sign in to continue.' }, 401);
  let body;
  try { body = await readAdminBody(request, 2 * 1024 * 1024); }
  catch { return adminResponse({ error: 'Invalid request or tour too large.' }, 400); }
  if (!body || !Number.isSafeInteger(body.revision) || body.revision < 0) return adminResponse({ error: 'Reload the builder and try again.' }, 400);
  const scene = (await readSourceScenes()).find(item => item.sceneId === id);
  if (!scene) return adminResponse({ error: 'Space not found.' }, 404);
  try {
    const experience = body.experience === null ? null : await parseExperienceFor(scene, body.experience);
    return adminResponse({ ok: true, tour: saveSceneTour(id, body.revision, experience) });
  } catch (error) {
    const status = error instanceof EditConflict ? 409 : error instanceof ExperienceError ? 400 : 500;
    if (status === 500) console.error('Unable to save a tour:', error);
    return adminResponse({ error: status === 500 ? 'Unable to save. Try again.' : (error as Error).message }, status);
  }
}
