import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/server/brand";

export const dynamic = "force-dynamic";

/**
 * Spaces, tours, profiles and guides may be crawled. Administration, the agents' endpoint and the API
 * stay out, except the pictures pages share (space and tour thumbnails, profile pictures, tour files).
 * Account pages say noindex themselves.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{
      userAgent: "*",
      allow: ["/", "/api/scenes/", "/api/tour-thumbs/", "/api/tour-files/", "/api/profile-files/"],
      disallow: ["/admin", "/api/", "/mcp"]
    }],
    sitemap: `${siteOrigin()}/sitemap.xml`
  };
}
