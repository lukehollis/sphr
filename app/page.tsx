import SphrApp from "@/components/SphrApp";
import SceneLibrary from "@/components/SceneLibrary";
import { readAllScenes, readSceneCatalog } from "@/lib/scene-catalog";
import { accessControlled } from "@/lib/server/admin-store";
import { isAdmin } from "@/lib/server/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  if (params.config && accessControlled()) {
    const config = typeof params.config === "string" ? params.config : "";
    const scene = (await readAllScenes()).find(item => config === item.bootstrapUrl
      || config === `/datasets/matterport/${item.slug}/bootstrap.json`
      || config === `${process.env.SPHR_ASSET_BASE_URL}/datasets/matterport/${item.slug}/bootstrap.json`);
    if (scene) redirect(scene.scenePath);
    if (!(await isAdmin())) redirect("/admin/login");
  }
  if (params.config || params.demo !== undefined) return <SphrApp />;
  return <SceneLibrary scenes={await readSceneCatalog()} showAdminLink={accessControlled()} />;
}
