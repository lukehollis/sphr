import { notFound, redirect } from "next/navigation";
import { accountsEnabled, currentUser, ownedSpace } from "@/lib/server/accounts";

export const dynamic = "force-dynamic";

/** Tours of a customer's space are the customer's own tours now; this older link starts one. */
export default async function CustomerSpaceTourPage({ params }: { params: Promise<{ id: string }> }) {
  if (!accountsEnabled()) notFound();
  const { id } = await params;
  if (!/^[a-f0-9]{12}$/.test(id)) notFound();
  if (!(await currentUser())) redirect(`/account/login?next=${encodeURIComponent(`/account/spaces/${id}/tour`)}`);
  const owned = await ownedSpace(id);
  if (!owned) notFound();
  redirect(owned.space.sceneId ? `/account/tours/new?scene=${owned.space.sceneId}` : `/account/spaces/${id}`);
}
