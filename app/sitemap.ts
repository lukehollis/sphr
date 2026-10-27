import type { MetadataRoute } from "next";
import { sitemapEntries } from "@/lib/server/search-pages";

// Read when asked, so a space made public today is listed today.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapEntries();
}
