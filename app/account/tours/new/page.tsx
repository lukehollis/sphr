import { notFound, redirect } from "next/navigation";
import TourSpacePicker from "@/components/TourSpacePicker";
import { readUser } from "@/lib/server/accounts-store";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { describeAccount } from "@/lib/server/customer-spaces";
import { buildableSpaces, buildReturnPath, canBuildOn, pickerSpace, readyToBuild } from "@/lib/server/user-tours";
import { applyCheckoutSession, billingEnabled } from "@/lib/server/billing";
import { readAllScenes } from "@/lib/scene-catalog";
import { siteBrand, siteHome } from "@/lib/server/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Make a tour or scavenger hunt", robots: { index: false, follow: false } };

export default async function NewTourPage({ searchParams }: { searchParams: Promise<{ scene?: string; kind?: string; checkout?: string }> }) {
  if (!accountsEnabled()) notFound();
  const { scene, kind, checkout } = await searchParams;
  const user = await currentUser();
  // Visitors arriving from "Build on this space" make an account first, then choose a plan.
  if (!user) redirect(`/account/signup?next=${encodeURIComponent(buildReturnPath(scene))}`);
  // Returning from Checkout usually beats the webhook; apply the result now.
  if (typeof checkout === "string" && billingEnabled()) {
    await applyCheckoutSession(checkout, user.id).catch(error => console.error("Unable to apply Checkout:", error instanceof Error ? error.message : error));
  }
  if (!readyToBuild(user.id)) redirect(`/account/plan?build=${typeof scene === "string" && /^[a-f0-9]{12}$/.test(scene) ? scene : "1"}`);
  const spaces = await buildableSpaces(user.id);
  // Someone else's space open to builders is never listed, so it comes from its link.
  const listed = typeof scene === "string" ? [...spaces.own, ...spaces.spacery].find(item => item.sceneId === scene) : undefined;
  const linked = !listed && typeof scene === "string" ? (await readAllScenes()).find(item => item.sceneId === scene) : undefined;
  const chosen = listed ?? (linked && canBuildOn(user.id, linked) ? pickerSpace(linked) : null);
  return <TourSpacePicker brand={siteBrand()} account={describeAccount(readUser(user.id)!)} own={spaces.own} spacery={spaces.spacery}
    chosen={chosen} kind={kind === "hunt" ? "hunt" : "tour"} paid={typeof checkout === "string"}
    agentsUrl={siteHome() ? `${siteHome()}/#start` : undefined} />;
}
