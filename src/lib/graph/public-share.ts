// Helpers for public workspace sharing slugs.

export function slugifyName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return base || "graph";
}

// Short, URL-safe, unguessable suffix so slugs don't collide and can't be
// enumerated from the graph name alone.
export function randomSlugSuffix(length = 7): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
}

export function buildPublicSlug(name: string): string {
  return `${slugifyName(name)}-${randomSlugSuffix()}`;
}
