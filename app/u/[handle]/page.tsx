import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import ProfileView from "@/components/ProfileView";
import { accountsEnabled, currentUser } from "@/lib/server/accounts";
import { siteBrand } from "@/lib/server/brand";
import { followCounts, isFollowing, readProfileByHandle, sharedCaptures, sharedTours } from "@/lib/server/profiles";
import { readUser } from "@/lib/server/accounts-store";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const profile = accountsEnabled() ? readProfileByHandle((await params).handle) : undefined;
  if (!profile) return { title: "Profile not found", robots: { index: false, follow: false } };
  const name = profile.name || profile.handle;
  const shared = (await sharedTours(profile.userId)).length + (await sharedCaptures(profile.userId)).length;
  const description = profile.bio?.slice(0, 200) || `Tours and captures by ${name}.`;
  const image = profile.cover || profile.avatar;
  return {
    title: `${name} (@${profile.handle}) · ${siteBrand()}`, description,
    alternates: { canonical: `/u/${profile.handle}` },
    // A profile that has shared nothing stays out of search results.
    ...(shared ? {} : { robots: { index: false, follow: true } }),
    openGraph: { type: "profile", title: `${name} on ${siteBrand()}`, description, url: `/u/${profile.handle}`, ...(image ? { images: [{ url: image }] } : {}) },
    twitter: { card: profile.cover ? "summary_large_image" : "summary", title: `${name} on ${siteBrand()}`, description, ...(image ? { images: [image] } : {}) }
  };
}

export default async function ProfilePage({ params }: Props) {
  if (!accountsEnabled()) notFound();
  const { handle } = await params;
  const profile = readProfileByHandle(handle);
  if (!profile) notFound();
  if (handle !== profile.handle) redirect(`/u/${profile.handle}`);
  const user = await currentUser();
  const nav = user ? [{ href: "/account", label: "Your spaces" }, { href: "/account/profile", label: "Profile", current: user.id === profile.userId }]
    : [{ href: `/account/login?next=${encodeURIComponent(`/u/${profile.handle}`)}`, label: "Sign in" }];
  return <ProfileView brand={siteBrand()} nav={nav} profile={{
    handle: profile.handle, name: profile.name || profile.handle, bio: profile.bio, location: profile.location, website: profile.website,
    avatar: profile.avatar, cover: profile.cover, joined: readUser(profile.userId)?.created ?? profile.created, path: `/u/${profile.handle}`, ...followCounts(profile.userId),
    tours: await sharedTours(profile.userId), captures: await sharedCaptures(profile.userId),
    viewer: { signedIn: Boolean(user), self: user?.id === profile.userId, following: isFollowing(user?.id, profile.userId) }
  }} />;
}
