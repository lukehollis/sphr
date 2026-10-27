import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { preload } from "react-dom";
import SphrApp from "@/components/SphrApp";
import { emptyExperience } from "@/lib/experience/types";
import { sceneTitleSlug } from "@/lib/scene-edits";
import { readSceneEdits } from "@/lib/server/admin-store";
import { sameTeam } from "@/lib/server/accounts-store";
import { currentUser, loginPath } from "@/lib/server/accounts";
import { readSpaceInfo } from "@/lib/server/space-info";
import { readSpaceTags } from "@/lib/server/space-tags";
import { hasHeart, heartCount, profileCard } from "@/lib/server/profiles";
import { siteOrigin, viewerHost } from "@/lib/server/brand";
import { buildOnPath, readUserTour, tourAccess, tourPath, tourScene } from "@/lib/server/user-tours";
import { askingNames } from "@/lib/server/tour-plays";
import { existingVariantsUrl } from "@/lib/server/variants";
import { existingLightCopies } from "@/lib/server/light";
import { loadingPlaceholder } from "@/lib/server/placeholder";
import { existingReconstructionUrl } from "@/lib/server/reconstructions";
import { searchMetadata, tourSearchPage } from "@/lib/server/search-pages";
import PageText from "@/components/PageText";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string; slug?: string[] }> };

/** A customer's tour or scavenger hunt is listed by search engines once it is shared on a public space. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const tour = readUserTour((await params).id);
  const page = tour && await tourAccess(tour) === "allowed" ? await tourSearchPage(tour.id) : undefined;
  if (!page) return { title: "Tour not found", robots: { index: false, follow: false } };
  return searchMetadata(page);
}

export default async function TourPage({ params }: Props) {
  const { id, slug } = await params;
  const tour = readUserTour(id);
  if (!tour) notFound();
  const access = await tourAccess(tour);
  if (access === "unavailable") notFound();
  if (access === "login") redirect(loginPath(tourPath(tour)));
  const scene = await tourScene(tour);
  if (!scene) notFound();
  if (slug?.length !== 1 || slug[0] !== sceneTitleSlug(tour.title)) redirect(tourPath(tour));
  // The scene file starts with the page rather than after the viewer's code (it is what the viewer asks for first).
  preload(scene.bootstrapUrl, { as: "fetch", crossOrigin: "anonymous" });
  const [variants, reconstruction, light, placeholder, page] = await Promise.all([existingVariantsUrl(scene.sceneId), existingReconstructionUrl(scene.sceneId), existingLightCopies(scene.sceneId), loadingPlaceholder(scene.thumbnail), tourSearchPage(tour.id)]);
  const user = await currentUser();
  // Players (not the owner trying it out) give their name for the owner's class results, unless the owner turned that off.
  const play = !(user && sameTeam(user.id, tour.userId)) && askingNames(tour.id) ? { tourId: tour.id, kind: tour.kind } : undefined;
  return <><SphrApp key={tour.id} configUrl={scene.bootstrapUrl} play={play}
    edits={{ title: tour.title, startView: readSceneEdits().get(scene.sceneId)?.startView ?? null, experience: tour.experience ?? emptyExperience(tour.kind), standalone: true, variants, reconstruction, light, tags: readSpaceTags(scene.sceneId).tags }}
    preview={{ title: tour.title, image: placeholder, added: scene.createdAt }} host={viewerHost()} share={{ url: `${siteOrigin()}${tourPath(tour)}`, public: tour.public }} build={await buildOnPath(scene.sceneId)} info={readSpaceInfo(scene.sceneId).info}
    social={{ creator: profileCard(tour.userId), heart: { tourId: tour.id, count: heartCount(tour.id), hearted: hasHeart(user?.id, tour.id), signedIn: Boolean(user), loginPath: loginPath(tourPath(tour)) } }} />
    {page && <PageText page={page} />}</>;
}
