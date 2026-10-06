import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { preload } from "react-dom";
import SphrApp from "@/components/SphrApp";
import { emptyExperience } from "@/lib/experience/types";
import { sceneTitleSlug } from "@/lib/scene-edits";
import { readSceneEdits } from "@/lib/server/admin-store";
import { currentUser, loginPath } from "@/lib/server/accounts";
import { readSpaceInfo } from "@/lib/server/space-info";
import { tourThumbnail } from "@/lib/server/tour-thumbnails";
import { hasHeart, heartCount, profileCard } from "@/lib/server/profiles";
import { siteBrand, viewerHost } from "@/lib/server/brand";
import { buildOnPath, readUserTour, tourAccess, tourPath, tourScene } from "@/lib/server/user-tours";
import { existingVariantsUrl } from "@/lib/server/variants";
import { existingLightCopies } from "@/lib/server/light";
import { loadingPlaceholder } from "@/lib/server/placeholder";
import { existingReconstructionUrl } from "@/lib/server/reconstructions";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string; slug?: string[] }> };

/** A customer's tour or scavenger hunt is reached by its link only and is never indexed. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const tour = readUserTour((await params).id);
  const scene = tour && await tourAccess(tour) === "allowed" ? await tourScene(tour) : undefined;
  if (!tour || !scene) return { title: "Tour not found", robots: { index: false, follow: false } };
  const description = tour.kind === "hunt" ? `Play a scavenger hunt in ${scene.title}.` : `Take a guided tour of ${scene.title}.`;
  const image = tourThumbnail(tour.id) ?? scene.thumbnail;
  return {
    title: `${tour.title} · ${siteBrand()}`, description, robots: { index: false, follow: false },
    openGraph: { type: "website", title: tour.title, description, url: tourPath(tour), images: [{ url: image, alt: tour.title }] },
    twitter: { card: "summary_large_image", title: tour.title, description, images: [image] }
  };
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
  const [variants, reconstruction, light, placeholder] = await Promise.all([existingVariantsUrl(scene.sceneId), existingReconstructionUrl(scene.sceneId), existingLightCopies(scene.sceneId), loadingPlaceholder(scene.thumbnail)]);
  const user = await currentUser();
  return <SphrApp key={tour.id} configUrl={scene.bootstrapUrl}
    edits={{ title: tour.title, startView: readSceneEdits().get(scene.sceneId)?.startView ?? null, experience: tour.experience ?? emptyExperience(tour.kind), standalone: true, variants, reconstruction, light }}
    preview={{ title: tour.title, image: placeholder, added: scene.createdAt }} host={viewerHost()} build={await buildOnPath(scene.sceneId)} info={readSpaceInfo(scene.sceneId).info}
    social={{ creator: profileCard(tour.userId), heart: { tourId: tour.id, count: heartCount(tour.id), hearted: hasHeart(user?.id, tour.id), signedIn: Boolean(user), loginPath: loginPath(tourPath(tour)) } }} />;
}
