import { notFound, redirect } from "next/navigation";
import SpaceManager from "@/components/SpaceManager";
import { accountsEnabled, currentUser, ownedSpace } from "@/lib/server/accounts";
import { describeAccount, describeSpace } from "@/lib/server/customer-spaces";

export const dynamic = "force-dynamic";
export const metadata = { title: "Manage space", robots: { index: false, follow: false } };

export default async function ManageSpacePage({ params }: { params: Promise<{ id: string }> }) {
  if (!accountsEnabled()) notFound();
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id)) notFound();
  if (!(await currentUser())) redirect(`/account/login?next=${encodeURIComponent(`/account/spaces/${id}`)}`);
  const owned = await ownedSpace(id);
  if (!owned) notFound();
  return <SpaceManager space={await describeSpace(owned.space)} account={describeAccount(owned.user)} />;
}
