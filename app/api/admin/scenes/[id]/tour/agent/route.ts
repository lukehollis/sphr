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
  if (body?.stream === true) {
    const origin = new URL(request.url).origin;
    const team = await isTeamEditor();
    const encoder = new TextEncoder();
    const bodyStream = new ReadableStream({
      async start(controller) {
        const sendLine = (payload: Record<string, unknown>) => {
          try { controller.enqueue(encoder.encode(JSON.stringify(payload) + '\n')); } catch { /* stream closed */ }
        };
        const heartbeat = setInterval(() => sendLine({ type: 'ping' }), 5000);
        try {
          const result = await draftFromRequest(scene, body, origin, team, {
            onLog: (text) => sendLine({ type: 'log', text })
          });
          sendLine({ type: 'done', ok: true, ...result });
        } catch (error) {
          if (error instanceof TourAgentError) sendLine({ type: 'error', status: 422, error: error.message });
          else {
            console.error('Tour agent failed:', error);
            sendLine({ type: 'error', status: 502, error: 'The agent could not finish. Try again.' });
          }
        } finally {
          clearInterval(heartbeat);
          try { controller.close(); } catch { /* already closed */ }
        }
      }
    });
    return new Response(bodyStream, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }
    });
  }
  try {
    return adminResponse({ ok: true, ...await draftFromRequest(scene, body, new URL(request.url).origin, await isTeamEditor()) });
  } catch (error) {
    if (error instanceof TourAgentError) return adminResponse({ error: error.message }, 422);
    console.error('Tour agent failed:', error);
    return adminResponse({ error: 'The agent could not finish. Try again.' }, 502);
  }
}
