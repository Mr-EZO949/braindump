import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isAllowlistEnabled, isEmailAllowed } from "@/lib/auth/allowlist";

// Invite-only gate. When ALLOWED_EMAILS is set, only those accounts may reach
// the app UI (/app/*) or its data/AI APIs (/api/*). Everything else — the
// landing page and its waitlist signup, /login, the OAuth callback, /privacy, /terms — stays public so
// people can still sign in and get bounced if they're not on the list.
export async function middleware(request: NextRequest) {
  // No allowlist configured → gate off entirely (local dev, or before it's set).
  if (!isAllowlistEnabled()) {
    return NextResponse.next();
  }

  const path = request.nextUrl.pathname;

  // Vercel cron calls these machine-to-machine (authed by CRON_SECRET, no user
  // cookie). Gating them would break the nudge / cleanup jobs.
  if (path.startsWith("/api/cron")) {
    return NextResponse.next();
  }

  // The landing page's waitlist form posts here signed out — that's its job.
  if (path === "/api/waitlist") {
    return NextResponse.next();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // If auth isn't configured, don't hard-lock the app out of caution.
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.next();
  }

  // Standard @supabase/ssr middleware dance: read cookies off the request,
  // let a refreshed session write them back onto the response.
  let response = NextResponse.next({ request });
  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, options, value }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // getClaims() verifies the session JWT locally against the project's
  // (cached) ES256 signing keys — getUser() made a round trip to Supabase Auth
  // in front of EVERY API call. Route handlers still call getUser() themselves.
  const { data: claimsData } = await supabase.auth.getClaims();
  const user = claimsData?.claims
    ? { email: typeof claimsData.claims.email === "string" ? claimsData.claims.email : undefined }
    : null;

  if (isEmailAllowed(user?.email)) {
    return response;
  }

  // Signed out, or signed in with an email that's not on the list.
  if (path.startsWith("/api")) {
    return NextResponse.json(
      { error: user ? "This account is not on the access list." : "Not authenticated." },
      { status: user ? 403 : 401 },
    );
  }

  const redirectUrl = request.nextUrl.clone();
  redirectUrl.pathname = "/login";
  redirectUrl.search = user ? "?denied=1" : "";
  return NextResponse.redirect(redirectUrl);
}

export const config = {
  matcher: ["/app/:path*", "/n/:path*", "/api/:path*"],
};
