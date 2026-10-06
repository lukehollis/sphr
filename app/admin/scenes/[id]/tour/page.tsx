import { notFound, redirect } from 'next/navigation';
import TourBuilder from '@/components/TourBuilder';
import { readAllScenes } from '@/lib/scene-catalog';
import { applySceneEdits } from '@/lib/scene-edits';
import { experienceFromBootstrap } from '@/lib/experience/apply';
import { emptyExperience } from '@/lib/experience/types';
import { accessControlled, readSceneEdits } from '@/lib/server/admin-store';
import { readSceneTour } from '@/lib/server/tours';
import { isAdmin } from '@/lib/server/auth';
import { libraryModels } from '@/lib/server/library';
import { readSceneBootstrap } from '@/lib/server/scene-editor';
import { tourAgentConfigured } from '@/lib/server/tour-agent';
import { existingVariantsUrl } from "@/lib/server/variants";
import { existingLightCopies } from "@/lib/server/light";
import { existingReconstructionUrl } from "@/lib/server/reconstructions";

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Tour builder', robots: { index: false, follow: false } };

export default async function TourBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  if (!accessControlled()) notFound();
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id)) notFound();
  if (!(await isAdmin())) redirect(`/admin/login?next=${encodeURIComponent(`/admin/scenes/${id}`)}`);
  const scene = (await readAllScenes()).find(item => item.sceneId === id);
  if (!scene) notFound();
  const sceneEdits = readSceneEdits().get(id);
  const [variants, reconstruction, light] = await Promise.all([existingVariantsUrl(scene.sceneId), existingReconstructionUrl(scene.sceneId), existingLightCopies(scene.sceneId)]);
  const edits = { title: scene.title, startView: sceneEdits?.startView ?? null, variants, reconstruction, light };
  const saved = readSceneTour(id);
  let initial = saved.experience;
  if (!initial) {
    try { initial = experienceFromBootstrap(applySceneEdits(await readSceneBootstrap(scene), edits)); }
    catch { initial = emptyExperience(); }
  }
  return <TourBuilder scene={scene} edits={edits} initial={initial} saved={saved} library={await libraryModels(true)}
    agentReady={tourAgentConfigured()} back={{ href: `/admin/scenes/${id}`, label: 'Edit space' }} api={`/api/admin/scenes/${id}/tour`} />;
}
