import { notFound, redirect } from "next/navigation";
import ProfileEditor from "@/components/ProfileEditor";
import { accountNav } from "@/lib/account-nav";
import { accountsEnabled, currentUser, publicOrigin } from "@/lib/server/accounts";
import { describeAccount } from "@/lib/server/customer-spaces";
import { siteBrand } from "@/lib/server/brand";
import { ensureProfile, profileLimits } from "@/lib/server/profiles";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your profile", robots: { index: false, follow: false } };

export default async function EditProfilePage() {
  if (!accountsEnabled()) notFound();
  const user = await currentUser();
  if (!user) redirect(`/account/login?next=${encodeURIComponent("/account/profile")}`);
  return <ProfileEditor brand={siteBrand()} nav={accountNav(describeAccount(user), "profile")} email={user.email}
    host={new URL(publicOrigin()).host} profile={ensureProfile(user.id)} limits={profileLimits} />;
}
