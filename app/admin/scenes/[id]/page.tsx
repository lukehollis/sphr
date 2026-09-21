import { notFound, redirect } from 'next/navigation';
import SpaceEditor from '@/components/SpaceEditor';
import { readAllScenes } from '@/lib/scene-catalog';
import { accessControlled, readSceneEdits } from '@/lib/server/admin-store';
import { isAdmin } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Edit space', robots: { index: false, follow: false } };
export default async function EditSpacePage({ params }: { params: Promise<{ id: string }> }) {
  if (!accessControlled()) notFound();
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id)) notFound();
  if (!(await isAdmin())) redirect(`/admin/login?next=${encodeURIComponent(`/admin/scenes/${id}`)}`);
  const scene = (await readAllScenes()).find(item => item.sceneId === id);
  if (!scene) notFound();
  const edits = readSceneEdits().get(id) ?? { title: null, startView: null, revision: 0, thumbnailVersion: null };
  return <SpaceEditor scene={scene} edits={edits} />;
}
