import { readSourceScenes } from '@/lib/scene-catalog';
import { openingSpace } from '@/lib/scene-edits';
import { parseExperience } from '@/lib/experience/validate';
import { emptyExperience } from '@/lib/experience/types';
import { adminResponse, readAdminBody } from '@/lib/server/auth';
import { readSceneBootstrap } from '@/lib/server/scene-editor';
import { canEditTour, isTeamEditor } from '@/lib/server/tour-access';
import { composeTour, TourAgentError, type AgentTurn, type ClientView } from '@/lib/server/tour-agent';

export const maxDuration = 300;

/** Ask the tour agent for a new draft. Nothing is saved until the editor saves. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id) || !(await canEditTour(id))) return adminResponse({ error: 'Sign in to continue.' }, 401);
  let body;
  try { body = await readAdminBody(request, 10 * 1024 * 1024); }
  catch { return adminResponse({ error: 'Invalid request.' }, 400); }
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt || prompt.length > 6000) return adminResponse({ error: 'Describe the tour in up to 6000 characters.' }, 400);
  const scene = (await readSourceScenes()).find(item => item.sceneId === id);
  if (!scene) return adminResponse({ error: 'Space not found.' }, 404);
  try {
    const bootstrap = await readSceneBootstrap(scene);
    const space = openingSpace(bootstrap);
    let draft;
    try { draft = parseExperience(body.experience, { lenient: true }); } catch { draft = emptyExperience(); }
    const history: AgentTurn[] = Array.isArray(body.history) ? body.history.slice(-6).flatMap((turn: unknown) => {
      const item = turn as Record<string, unknown>;
      return typeof item?.prompt === 'string' && typeof item.reply === 'string' ? [{ prompt: item.prompt.slice(0, 2000), reply: item.reply.slice(0, 1000) }] : [];
    }) : [];
    const views: ClientView[] = Array.isArray(body.views) ? body.views.slice(0, 4).flatMap((view: unknown) => {
      const item = view as Record<string, unknown>;
      return typeof item?.id === 'string' && typeof item.image === 'string' ? [{ id: item.id.slice(0, 40), image: item.image,
        nodeId: typeof item.nodeId === 'string' ? item.nodeId : undefined,
        rotation: item.rotation as ClientView['rotation'], fov: typeof item.fov === 'number' ? item.fov : undefined }] : [];
    }) : [];
    const result = await composeTour({
      bootstrap: { ...bootstrap, space }, draft, prompt, history, views,
      origin: new URL(request.url).origin, kind: body.kind === 'hunt' ? 'hunt' : 'tour', team: await isTeamEditor()
    });
    return adminResponse({ ok: true, experience: result.experience, anchors: result.anchors, reply: result.reply });
  } catch (error) {
    if (error instanceof TourAgentError) return adminResponse({ error: error.message }, 422);
    console.error('Tour agent failed:', error);
    return adminResponse({ error: 'The agent could not finish. Try again.' }, 502);
  }
}
