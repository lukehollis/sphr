import { readSourceScenes } from '@/lib/scene-catalog';
import { adminResponse, readAdminBody } from '@/lib/server/auth';
import { canEditTour, isTeamEditor } from '@/lib/server/tour-access';
import { TourAgentError } from '@/lib/server/tour-agent';
import { draftFromRequest } from '@/lib/server/tour-requests';

export const maxDuration = 300;

/** Ask the tour agent for a new draft. Nothing is saved until the editor saves. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id) || !(await canEditTour(id))) return adminResponse({ error: 'Sign in to continue.' }, 401);
  let body;
  try { body = await readAdminBody(request, 10 * 1024 * 1024); }
  catch { return adminResponse({ error: 'Invalid request.' }, 400); }
  const scene = (await readSourceScenes()).find(item => item.sceneId === id);
  if (!scene) return adminResponse({ error: 'Space not found.' }, 404);
  try {
    return adminResponse({ ok: true, ...await draftFromRequest(scene, body, new URL(request.url).origin, await isTeamEditor()) });
  } catch (error) {
    if (error instanceof TourAgentError) return adminResponse({ error: error.message }, 422);
    console.error('Tour agent failed:', error);
    return adminResponse({ error: 'The agent could not finish. Try again.' }, 502);
  }
}
