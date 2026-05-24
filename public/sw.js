const CACHE_NAME = "puti-pwa-cache-v2";
const STATIC_ASSETS = [
  "/manifest.json",
  "/main-logo.png",
  "/logo_typography.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        }),
      );
    }),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 0. BYPASS SERVER-SENT EVENTS (SSE)
  // Penting agar notifikasi suara real-time tidak tertahan oleh Service Worker
  if (
    request.headers.get("accept") &&
    request.headers.get("accept").includes("text/event-stream")
  ) {
    return; // Biarkan browser menangani SSE secara native
  }

  // 1. STATIC ASSETS (Cache First)
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then((response) => response || fetch(request)),
    );
    return;
  }

  // 2. CDN & External Resources (Stale-While-Revalidate)
  // Misalnya: Tailwind CSS, Google Fonts
  if (url.origin !== location.origin) {
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        const fetchPromise = fetch(request).then((networkResponse) => {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, networkResponse.clone());
          });
          return networkResponse;
        });
        return cachedResponse || fetchPromise;
      }),
    );
    return;
  }

  // 3. HTML & Dynamic Content (Network First)
  // Mencegah user melihat data absensi yang lama/stale
  if (
    request.mode === "navigate" ||
    request.headers.get("accept").includes("text/html")
  ) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseClone = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, responseClone));
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Default: Network First
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
