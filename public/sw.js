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

// Web-push: the cron sends a JSON payload with title/body/node_id. We show
// it as a system notification and route the click back into the app at the
// linked node (if any).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "BrainDump";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { node_id: data.node_id || null, nudge_id: data.nudge_id || null },
    tag: data.nudge_id || undefined,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { node_id } = event.notification.data || {};
  const target = node_id ? `/app?node=${encodeURIComponent(node_id)}` : "/app";

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Re-use an open app tab if there is one.
      for (const client of allClients) {
        try {
          const url = new URL(client.url);
          if (url.pathname.startsWith("/app")) {
            await client.focus();
            client.postMessage({ type: "nudge:open", node_id });
            return;
          }
        } catch {
          // skip malformed
        }
      }
      await self.clients.openWindow(target);
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
