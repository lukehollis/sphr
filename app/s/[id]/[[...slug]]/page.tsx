import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import SphrApp from "@/components/SphrApp";
import { findScene, readAllScenes } from "@/lib/scene-catalog";
import { isScenePublic } from "@/lib/server/admin-store";
import { isAdmin } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string; slug?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const scene = await findScene((await params).id);
  if (!scene) return { title: "Space not found", robots: { index: false, follow: false } };
  const description = scene.legacy?.kind === 'tour' ? `Take a guided tour of ${scene.title}.`
    : `Explore ${scene.title} in an interactive spatial viewer.`;
  return {
    title: `${scene.title} · SPHR`, description,
    ...(!isScenePublic(scene.sceneId) ? { robots: { index: false, follow: false } } : {}),
    alternates: { canonical: scene.scenePath },
    openGraph: { type: "website", title: scene.title, description, url: scene.scenePath, images: [{ url: scene.thumbnail, alt: scene.title }] },
    twitter: { card: "summary_large_image", title: scene.title, description, images: [scene.thumbnail] }
  };
}

export default async function ScenePage({ params }: Props) {
  const { id, slug } = await params;
  const scene = /^[a-f0-9]{12}$/.test(id) ? (await readAllScenes()).find(item => item.sceneId === id) : undefined;
  if (!scene) notFound();
  if (!isScenePublic(id) && !(await isAdmin())) redirect(`/admin/login?next=${encodeURIComponent(scene.scenePath)}`);
  // Resolve by ID. Old titles and ID-only links lead to the current canonical URL.
  if (slug?.length !== 1 || slug[0] !== scene.titleSlug) redirect(scene.scenePath);
  return <SphrApp key={scene.sceneId} configUrl={scene.bootstrapUrl} preview={{ title: scene.title, image: scene.thumbnail }} />;
}
