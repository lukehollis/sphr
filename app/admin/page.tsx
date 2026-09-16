import { notFound, redirect } from "next/navigation";
import AdminPanel from "@/components/AdminPanel";
import { readAllScenes } from "@/lib/scene-catalog";
import { accessControlled, isScenePublic } from "@/lib/server/admin-store";
import { isAdmin } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Manage spaces", robots: { index: false, follow: false } };

export default async function AdminPage() {
  if (!accessControlled()) notFound();
  if (!(await isAdmin())) redirect("/admin/login");
  return <AdminPanel scenes={(await readAllScenes()).map(scene => ({ ...scene, public: isScenePublic(scene.sceneId) }))} />;
}
