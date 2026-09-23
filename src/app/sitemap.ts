import type { MetadataRoute } from "next";

import { absoluteUrl } from "@/lib/site";

// Served at /sitemap.xml. Only PUBLIC, indexable pages belong here — the app
// itself is auth-gated, so it's excluded. Add new public marketing/content
// pages here as they ship (a blog is the highest-leverage addition for SEO).
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: absoluteUrl("/"), lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: absoluteUrl("/login"), lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: absoluteUrl("/privacy"), lastModified: now, changeFrequency: "yearly", priority: 0.2 },
    { url: absoluteUrl("/terms"), lastModified: now, changeFrequency: "yearly", priority: 0.2 },
  ];
}
