// "Oct 20" from a YYYY-MM-DD (or ISO) date — timezone-proof. Kept dependency-free
// so client components can import it without pulling in server config.
export function formatShortDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
