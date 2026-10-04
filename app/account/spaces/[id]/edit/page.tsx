import { notFound, redirect } from "next/navigation";
import SpaceEditor from "@/components/SpaceEditor";
import { readAllScenes } from "@/lib/scene-catalog";
import { readSceneEdits } from "@/lib/server/admin-store";
import { accountsEnabled, currentUser, ownedSpace } from "@/lib/server/accounts";
import { accountNav } from "@/lib/account-nav";
import { describeAccount } from "@/lib/server/customer-spaces";
import { siteBrand } from "@/lib/server/brand";
import { readSpaceInfo } from "@/lib/server/space-info";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit space", robots: { index: false, follow: false } };

export default async function EditCustomerSpacePage({ params }: { params: Promise<{ id: string }> }) {
  if (!accountsEnabled()) notFound();
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id)) notFound();
  if (!(await currentUser())) redirect(`/account/login?next=${encodeURIComponent(`/account/spaces/${id}/edit`)}`);
  const owned = await ownedSpace(id);
  const scene = owned?.space.sceneId ? (await readAllScenes()).find(item => item.sceneId === owned.space.sceneId) : undefined;
  if (!owned || !scene) notFound();
  const edits = readSceneEdits().get(scene.sceneId) ?? { title: null, startView: null, revision: 0, thumbnailVersion: null };
  const { info, revision } = readSpaceInfo(scene.sceneId);
  return <SpaceEditor scene={scene} edits={edits} info={info} infoRevision={revision} back={{ href: `/account/spaces/${id}`, label: scene.title }}
    tourHref={`/account/spaces/${id}/tour`} header={{ brand: siteBrand(), nav: accountNav(describeAccount(owned.user), "space"), account: owned.user.email, signOut: "account" }} />;
}
