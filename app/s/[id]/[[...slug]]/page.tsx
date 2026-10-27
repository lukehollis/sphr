import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { preload } from "react-dom";
import SphrApp from "@/components/SphrApp";
import { readSceneTour } from "@/lib/server/tours";
import { findScene, readAllScenes } from "@/lib/scene-catalog";
import { isScenePublic, readSceneEdits } from "@/lib/server/admin-store";
import { loginPath, sceneAccess } from "@/lib/server/accounts";
import { siteOrigin, viewerHost } from "@/lib/server/brand";
import { existingVariantsUrl } from "@/lib/server/variants";
import { existingLightCopies } from "@/lib/server/light";
import { loadingPlaceholder } from "@/lib/server/placeholder";
import { buildOnPath } from "@/lib/server/user-tours";
import { readSpaceInfo } from "@/lib/server/space-info";
import { readSpaceTags } from "@/lib/server/space-tags";
import { existingReconstructionUrl } from "@/lib/server/reconstructions";
import { searchMetadata, spaceSearchPage } from "@/lib/server/search-pages";
import PageText from "@/components/PageText";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string; slug?: string[] }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };

/** The canonical path with the request's own query kept, so embed and viewer options survive a renamed link. */
function withQuery(path: string, query: Record<string, string | string[] | undefined> = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(key, item);
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const scene = await findScene((await params).id);
  const page = scene && await spaceSearchPage(scene.sceneId);
  if (!page) return { title: "Space not found", robots: { index: false, follow: false } };
  return searchMetadata(page);
}

export default async function ScenePage({ params, searchParams }: Props) {
  const { id, slug } = await params;
  const scene = /^[a-f0-9]{12}$/.test(id) ? (await readAllScenes()).find(item => item.sceneId === id) : undefined;
  if (!scene) notFound();
  const access = await sceneAccess(id);
  if (access === "unavailable") notFound();
  if (access === "login") redirect(loginPath(scene.scenePath));
  // Resolve by ID. Old titles and ID-only links lead to the current canonical URL, named after the
  // space's tour when it has a titled one.
  if (slug?.length !== 1 || slug[0] !== scene.titleSlug) redirect(withQuery(scene.scenePath, await searchParams));
  // The scene file starts with the page rather than after the viewer's code (it is what the viewer asks for first).
  preload(scene.bootstrapUrl, { as: "fetch", crossOrigin: "anonymous" });
  const [variants, reconstruction, light, placeholder, page] = await Promise.all([existingVariantsUrl(id), existingReconstructionUrl(id), existingLightCopies(id), loadingPlaceholder(scene.thumbnail), spaceSearchPage(id)]);
  return <><SphrApp key={scene.sceneId} configUrl={scene.bootstrapUrl} edits={{ title: scene.title, startView: readSceneEdits().get(id)?.startView ?? null, experience: readSceneTour(id).experience, variants, reconstruction, light, tags: readSpaceTags(id).tags }} preview={{ title: scene.title, image: placeholder, added: scene.createdAt }} host={viewerHost()} info={readSpaceInfo(id).info} build={await buildOnPath(id)}
    share={{ url: `${siteOrigin()}${scene.scenePath}`, public: isScenePublic(id) }} />
    {page && <PageText page={page} />}</>;
}
