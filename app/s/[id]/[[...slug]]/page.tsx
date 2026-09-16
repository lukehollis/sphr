import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import SphrApp from "@/components/SphrApp";
import { findScene } from "@/lib/scene-catalog";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ id: string; slug?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const scene = await findScene((await params).id);
  if (!scene) return { title: "Space not found" };
  const description = `Explore ${scene.title} in 360°, with ${scene.nodeCount} locations and an interactive dollhouse view.`;
  return {
    title: `${scene.title} · SPHR`, description,
    alternates: { canonical: scene.scenePath },
    openGraph: { type: "website", title: scene.title, description, url: scene.scenePath, images: [{ url: scene.thumbnail, alt: scene.title }] },
    twitter: { card: "summary_large_image", title: scene.title, description, images: [scene.thumbnail] }
  };
}

export default async function ScenePage({ params }: Props) {
  const { id, slug } = await params;
  const scene = await findScene(id);
  if (!scene) notFound();
  // Resolve by ID. Old titles and ID-only links lead to the current canonical URL.
  if (slug?.length !== 1 || slug[0] !== scene.titleSlug) redirect(scene.scenePath);
  return <SphrApp key={scene.sceneId} configUrl={scene.bootstrapUrl} sharePath={scene.scenePath} />;
}
