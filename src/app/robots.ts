import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

// Served at /robots.txt. Let search engines crawl the public marketing +
// legal pages, but keep the authenticated app and API out of the index (they
// require login and have no SEO value). Points crawlers at the sitemap.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/app", "/api/", "/auth/", "/n/", "/p/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
