// Canonical site URL, used for SEO metadata (metadataBase, canonical URLs,
// OpenGraph), robots.ts and sitemap.ts.
//
// The production domain is the branded custom domain, NOT the *.vercel.app host,
// so canonical/OG links point at the brand. Resolution:
//   1. NEXT_PUBLIC_SITE_URL — override (e.g. a staging domain), if ever needed.
//   2. In production: the canonical custom domain below.
//   3. In dev: localhost.
const PRODUCTION_URL = "https://www.thebraindump.app";

function resolveSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  if (process.env.NODE_ENV === "production") return PRODUCTION_URL;

  return "http://localhost:3000";
}

export const SITE_URL = resolveSiteUrl();

// Absolute URL helper for canonical / OG tags.
export function absoluteUrl(path = "/"): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
