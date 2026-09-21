import { findScene } from '@/lib/scene-catalog';
import { readSceneThumbnail } from '@/lib/server/admin-store';

export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scene = await findScene(id);
  const thumbnail = scene ? readSceneThumbnail(id) : undefined;
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (!thumbnail) return new Response(null, { status: 404, headers });
  return new Response(new Uint8Array(thumbnail), { headers: { ...headers, 'Content-Type': 'image/jpeg' } });
}
