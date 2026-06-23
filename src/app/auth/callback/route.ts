// GET /auth/callback
// OAuth (Google/GitHub) and email-confirmation return point. Supabase sends the
// user back here with `?code=...` (PKCE authorization code). We exchange it for
// a session on the server client — which writes the auth cookies — then redirect
// into the app. `?next=` lets a caller route somewhere other than /app on success.
//
// On any failure we bounce back to /login with a human-readable `?error=`.

import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/app";

  // Only allow same-origin relative paths for `next` to avoid open redirects.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/app";

  const loginRedirect = (message: string) =>
    NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(message)}`, url.origin),
    );

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

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return loginRedirect(error.message);
  }

  return NextResponse.redirect(new URL(safeNext, url.origin));
}
