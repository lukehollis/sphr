import SphrApp from "@/components/SphrApp";
import SceneLibrary from "@/components/SceneLibrary";
import { readSceneCatalog } from "@/lib/scene-catalog";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  if (params.config || params.demo !== undefined) return <SphrApp />;
  return <SceneLibrary scenes={await readSceneCatalog()} />;
}
