import { notFound, redirect } from "next/navigation";
import TourBuilder from "@/components/TourBuilder";
import { readAllScenes } from "@/lib/scene-catalog";
import { applySceneEdits } from "@/lib/scene-edits";
import { experienceFromBootstrap } from "@/lib/experience/apply";
import { emptyExperience } from "@/lib/experience/types";
import { readSceneEdits } from "@/lib/server/admin-store";
import { accountsEnabled, currentUser, ownedSpace } from "@/lib/server/accounts";
import { libraryModels } from "@/lib/server/library";
import { readSceneBootstrap } from "@/lib/server/scene-editor";
import { tourAgentConfigured } from "@/lib/server/tour-agent";
import { readSceneTour } from "@/lib/server/tours";
import { isTeamEditor } from "@/lib/server/tour-access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tour builder", robots: { index: false, follow: false } };

export default async function CustomerTourBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  if (!accountsEnabled()) notFound();
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id)) notFound();
  if (!(await currentUser())) redirect(`/account/login?next=${encodeURIComponent(`/account/spaces/${id}/tour`)}`);
  const owned = await ownedSpace(id);
  const scene = owned?.space.sceneId ? (await readAllScenes()).find(item => item.sceneId === owned.space.sceneId) : undefined;
  if (!owned || !scene) notFound();
  const edits = { title: scene.title, startView: readSceneEdits().get(scene.sceneId)?.startView ?? null };
  const saved = readSceneTour(scene.sceneId);
  let initial = saved.experience;
  if (!initial) {
    try { initial = experienceFromBootstrap(applySceneEdits(await readSceneBootstrap(scene), edits)); }
    catch { initial = emptyExperience(); }
  }
  return <TourBuilder scene={scene} edits={edits} initial={initial} saved={saved} library={await libraryModels(await isTeamEditor())}
    agentReady={tourAgentConfigured()} back={{ href: `/account/spaces/${id}`, label: scene.title }} api={`/api/admin/scenes/${scene.sceneId}/tour`} />;
}
