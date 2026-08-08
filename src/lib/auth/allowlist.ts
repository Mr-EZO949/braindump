// Email allowlist for gating the whole app behind an invite list.
//
// Controlled by the ALLOWED_EMAILS env var: a comma-separated list of emails
// that are allowed to use the app (case-insensitive). When the var is unset or
// empty the gate is DISABLED and everyone passes — so local dev, where the var
// is normally absent, is unaffected. Set it in Vercel to lock the live site.
//
// Used in two places that must agree: the middleware (blocks /app + /api) and
// the login page (so a denied-but-signed-in account isn't bounced back into a
// redirect loop).

export function getAllowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowlistEnabled(): boolean {
  return getAllowedEmails().length > 0;
}

export function isEmailAllowed(email: string | null | undefined): boolean {
  const allowed = getAllowedEmails();
  if (allowed.length === 0) return true; // gate disabled
  if (!email) return false;
  return allowed.includes(email.trim().toLowerCase());
}
