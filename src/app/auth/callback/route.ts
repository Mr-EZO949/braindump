// GET /auth/callback
// OAuth (Google / Apple) and email-confirmation return point. Supabase sends
// the user back here with `?code=...` (PKCE authorization code). We exchange it
// for a session on the server client — which writes the auth cookies — then
// redirect into the app. `?next=` lets a caller route somewhere other than /app.
//
// The invite allowlist (ALLOWED_EMAILS) applies here exactly as it does to a
// password sign-in: the session is kept, and an account that isn't on the list
// lands on /login?denied=1 instead of the app (the middleware would bounce it
// there anyway; checking here saves the hop and doesn't depend on its matcher).
//
// On any failure we bounce back to /login with a human-readable `?error=`.

import { NextResponse } from "next/server";

import { isEmailAllowed } from "@/lib/auth/allowlist";
import { safeNextPath } from "@/lib/auth/oauth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// The origin the browser used. `next dev -H 0.0.0.0` (npm run dev) reports
// request.url as http://0.0.0.0:<port>, and a redirect there would lose the
// session cookies just set for localhost — so prefer the Host the browser sent.
function browserOrigin(request: Request, url: URL): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return url.origin;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = browserOrigin(request, url);
  const code = url.searchParams.get("code");
  const safeNext = safeNextPath(url.searchParams.get("next"));

  const loginRedirect = (message: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, origin));

  // A provider-side failure (user cancelled consent, provider not enabled, …)
  // returns ?error / ?error_description and no code — surface it cleanly rather
  // than falling through to the generic "missing code" message below.
  const providerError =
    url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (providerError) {
    return loginRedirect(
      providerError === "access_denied" ? "Sign-in was cancelled." : providerError,
    );
  }

  if (!code) {
    return loginRedirect("Sign-in link was missing its authorization code.");
  }

  // Note: whether an OAuth login with an email that already has a password
  // account links to it or creates a duplicate is governed by the Supabase
  // dashboard ("one user per email") — it cannot be enforced here.

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return loginRedirect("Supabase auth is not configured.");
  }

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return loginRedirect(error.message);
  }

  if (!isEmailAllowed(data.user?.email)) {
    return NextResponse.redirect(new URL("/login?denied=1", origin));
  }

  return NextResponse.redirect(new URL(safeNext, origin));
}
