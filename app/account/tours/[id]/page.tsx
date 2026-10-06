import { notFound, redirect } from "next/navigation";
import TourBuilder from "@/components/TourBuilder";
import { emptyExperience } from "@/lib/experience/types";
import { readSceneEdits } from "@/lib/server/admin-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { libraryModels } from "@/lib/server/library";
import { tourAgentConfigured } from "@/lib/server/tour-agent";
import { canBuildOn, readUserTour, tourPath, tourScene } from "@/lib/server/user-tours";
import { existingVariantsUrl } from "@/lib/server/variants";
import { existingLightCopies } from "@/lib/server/light";
import { existingReconstructionUrl } from "@/lib/server/reconstructions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tour builder", robots: { index: false, follow: false } };

export default async function CustomerTourPage({ params }: { params: Promise<{ id: string }> }) {
  if (!accountsEnabled()) notFound();
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id)) notFound();
  const user = await currentUser();
  if (!user) redirect(`/account/login?next=${encodeURIComponent(`/account/tours/${id}`)}`);
  const tour = readUserTour(id);
  if (!tour || tour.userId !== user.id) notFound();
  const scene = await tourScene(tour);
  if (!scene || !canBuildOn(user.id, scene)) notFound();
  const [variants, reconstruction, light] = await Promise.all([existingVariantsUrl(scene.sceneId), existingReconstructionUrl(scene.sceneId), existingLightCopies(scene.sceneId)]);
  const edits = { title: scene.title, startView: readSceneEdits().get(scene.sceneId)?.startView ?? null, variants, reconstruction, light };
  return <TourBuilder scene={scene} edits={edits} initial={tour.experience ?? emptyExperience(tour.kind)} saved={{ experience: tour.experience, revision: tour.revision }}
    library={await libraryModels(false)} agentReady={tourAgentConfigured()} back={{ href: "/account", label: "Your spaces" }} api={`/api/account/tours/${tour.id}`}
    tour={{ id: tour.id, title: tour.title, public: tour.public, path: tourPath(tour), spaceTitle: scene.title }} />;
}
