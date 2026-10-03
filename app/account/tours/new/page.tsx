import { notFound, redirect } from "next/navigation";
import TourSpacePicker from "@/components/TourSpacePicker";
import { readUser } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { describeAccount } from "@/lib/server/customer-spaces";
import { buildableSpaces } from "@/lib/server/user-tours";
import { siteBrand } from "@/lib/server/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Make a tour or scavenger hunt", robots: { index: false, follow: false } };

export default async function NewTourPage({ searchParams }: { searchParams: Promise<{ scene?: string; kind?: string }> }) {
  if (!accountsEnabled()) notFound();
  const { scene, kind } = await searchParams;
  const user = await currentUser();
  if (!user) redirect(`/account/login?next=${encodeURIComponent(`/account/tours/new${typeof scene === "string" && /^[a-f0-9]{12}$/.test(scene) ? `?scene=${scene}` : ""}`)}`);
  const spaces = await buildableSpaces(user.id);
  const chosen = typeof scene === "string" ? [...spaces.own, ...spaces.spacery].find(item => item.sceneId === scene) : undefined;
  return <TourSpacePicker brand={siteBrand()} account={describeAccount(readUser(user.id)!)} own={spaces.own} spacery={spaces.spacery}
    chosen={chosen?.sceneId ?? null} kind={kind === "hunt" ? "hunt" : "tour"} />;
}
