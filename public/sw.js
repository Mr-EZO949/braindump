// BrainDump service worker — intentionally minimal.
//
// This app is auth-gated with live, per-user data. An aggressive offline
// cache would serve stale graphs or a logged-out shell, so this SW only
// does ONE safe thing: cache-first for immutable, content-hashed static
// assets. Everything dynamic (pages, API, auth) is pure network passthrough.
// The fetch handler still exists, which is what makes the app installable.

const CACHE = "braindump-static-v1";

// Only these are safe to cache-first: Next emits content-hashed filenames
// under /_next/static, and our icons are versioned by the manifest.
function isImmutableStatic(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/")
  );
}

self.addEventListener("install", (event) => {
  // Activate this SW immediately on first install / update.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from older SW versions.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never touch non-GET, cross-origin, or anything dynamic/auth-bearing.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!isImmutableStatic(url)) return; // pages + /api/* fall through to network

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        // Offline and not cached — let the failure surface normally.
        return Response.error();
      }
    })(),
  );
});
