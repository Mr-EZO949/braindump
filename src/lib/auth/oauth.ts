// Social sign-in (Supabase OAuth, PKCE) — which providers the login page offers
// and where they send the user back. Setup steps: docs/auth-oauth.md.
//
// Each provider shows only when its build-time flag is "true", so a deploy
// never offers a button whose provider isn't configured in Supabase (a click
// would land on "Unsupported provider: provider is not enabled").

export type OAuthProvider = "google" | "apple";

// NEXT_PUBLIC_* values are inlined at build time, so they must be read with
// the literal `process.env.NAME` spelling (here, not in a loop).
const FLAGS: Record<OAuthProvider, string | undefined> = {
  google: process.env.NEXT_PUBLIC_AUTH_GOOGLE,
  apple: process.env.NEXT_PUBLIC_AUTH_APPLE,
};

const ORDER: OAuthProvider[] = ["google", "apple"];

export function enabledOAuthProviders(
  flags: Partial<Record<OAuthProvider, string | undefined>> = FLAGS,
): OAuthProvider[] {
  return ORDER.filter((provider) => flags[provider]?.trim().toLowerCase() === "true");
}

// Only a same-origin path may follow a sign-in (no open redirects).
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/app";
  return next;
}

// Where the provider (through Supabase) returns the user. This exact URL must
// be on the Supabase project's redirect allow list.
export function oauthRedirectUrl(origin: string): string {
  return new URL("/auth/callback", origin).toString();
}
