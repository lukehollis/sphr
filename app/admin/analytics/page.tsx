import { notFound, redirect } from "next/navigation";
import AnalyticsReport from "@/components/AnalyticsReport";
import { accessControlled } from "@/lib/server/admin-store";
import { isAdmin } from "@/lib/server/auth";
import { siteBrand } from "@/lib/server/brand";
import { analyticsEnabled, markInternal } from "@/lib/server/analytics";
import { analyticsReport } from "@/lib/server/analytics-report";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics", robots: { index: false, follow: false } };

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  if (!accessControlled()) notFound();
  if (!(await isAdmin())) redirect("/admin/login?next=%2Fadmin%2Fanalytics");
  await markInternal();
  const requested = (await searchParams).days;
  const days = [7, 30, 90, 365].find(value => String(value) === requested) ?? 30;
  return <AnalyticsReport report={analyticsReport(days)} brand={siteBrand()} enabled={analyticsEnabled()} />;
}
