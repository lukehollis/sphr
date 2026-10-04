import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import SphrApp from "@/components/SphrApp";
import { readSceneTour } from "@/lib/server/tours";
import { findScene, readAllScenes } from "@/lib/scene-catalog";
import { isScenePublic, readSceneEdits } from "@/lib/server/admin-store";
import { loginPath, sceneAccess } from "@/lib/server/accounts";
import { siteBrand, viewerHost } from "@/lib/server/brand";
import { existingVariantsUrl } from "@/lib/server/variants";
import { buildOnPath } from "@/lib/server/user-tours";
import { readSpaceInfo } from "@/lib/server/space-info";
import { existingReconstructionUrl } from "@/lib/server/reconstructions";

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
  if (!scene) return { title: "Space not found", robots: { index: false, follow: false } };
  const description = readSpaceInfo(scene.sceneId).info.description?.slice(0, 300) || (scene.legacy?.kind === 'tour' ? `Take a guided tour of ${scene.title}.`
    : `Explore ${scene.title} in an interactive spatial viewer.`);
  return {
    title: `${scene.title} · ${siteBrand()}`, description,
    ...(!isScenePublic(scene.sceneId) ? { robots: { index: false, follow: false } } : {}),
    alternates: { canonical: scene.scenePath },
    openGraph: { type: "website", title: scene.title, description, url: scene.scenePath, images: [{ url: scene.thumbnail, alt: scene.title }] },
    twitter: { card: "summary_large_image", title: scene.title, description, images: [scene.thumbnail] }
  };
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
  const [variants, reconstruction] = await Promise.all([existingVariantsUrl(id), existingReconstructionUrl(id)]);
  return <SphrApp key={scene.sceneId} configUrl={scene.bootstrapUrl} edits={{ title: scene.title, startView: readSceneEdits().get(id)?.startView ?? null, experience: readSceneTour(id).experience, variants, reconstruction }} preview={{ title: scene.title, image: scene.thumbnail, added: scene.createdAt }} host={viewerHost()} info={readSpaceInfo(id).info} build={await buildOnPath(id)} />;
}
