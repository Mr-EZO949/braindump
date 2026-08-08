// Owner gate for the cross-user cost view.
//
// Controlled by the OWNER_EMAILS env var: a comma-separated list of emails
// (case-insensitive) allowed to see EVERY account's spend via the service-role
// key. Unlike the allowlist ([[allowlist.ts]]), this fails CLOSED — when the var
// is unset or empty, nobody is an owner and the cross-user view is unreachable.
// That's deliberate: a fail-open default here would leak every user's costs to
// any signed-in account.

export function getOwnerEmails(): string[] {
  return (process.env.OWNER_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const owners = getOwnerEmails();
  if (owners.length === 0) return false; // fail closed
  return owners.includes(email.trim().toLowerCase());
}
