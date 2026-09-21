import { notFound, redirect } from "next/navigation";
import { AdminLogin } from "@/components/AdminPanel";
import { accessControlled } from "@/lib/server/admin-store";
import { isAdmin } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin sign in", robots: { index: false, follow: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!accessControlled()) notFound();
  const next = (await searchParams).next;
  const returnPath = typeof next === "string" && /^(?:\/|\/s\/[a-f0-9]{12}(?:\/[a-z0-9-]+)?|\/admin\/scenes\/[a-f0-9]{12})$/.test(next) ? next : "/admin";
  if (await isAdmin()) redirect(returnPath);
  return <AdminLogin returnPath={returnPath} />;
}
