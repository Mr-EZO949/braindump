// Canonical site URL, used for SEO metadata (metadataBase, canonical URLs,
// OpenGraph), robots.ts and sitemap.ts.
//
// Resolution order:
//   1. NEXT_PUBLIC_SITE_URL — set this to your real custom domain in prod
//      (e.g. https://braindump.app). This is the one to configure.
//   2. VERCEL_PROJECT_PRODUCTION_URL — Vercel injects the production *.vercel.app
//      domain automatically, so canonical URLs are still absolute even if (1)
//      isn't set. (This is the vercel.app host, not your custom domain — prefer
//      setting NEXT_PUBLIC_SITE_URL so canonicals point at the branded domain.)
//   3. localhost — dev fallback.

function resolveSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;

  return "http://localhost:3000";
}

export const SITE_URL = resolveSiteUrl();

// Absolute URL helper for canonical / OG tags.
export function absoluteUrl(path = "/"): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
