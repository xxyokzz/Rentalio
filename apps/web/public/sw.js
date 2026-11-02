/*
 * Service worker Rentalio — kebijakan konservatif (Notion 09 §8):
 * - Cache HANYA aset statis yang sudah ditinjau (ikon, bundle Next statis).
 * - Tidak pernah menyimpan respons API, dokumen HTML dashboard, autentikasi,
 *   pembayaran, atau data tenant di cache offline umum.
 * - Navigasi: network-first; jika offline, tampilkan halaman /offline.
 */
const CACHE_NAME = "rentalio-static-v1";
const PRECACHE = ["/offline", "/icons/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest"
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const offline = await cache.match("/offline");
        return (
          offline ||
          new Response("Anda sedang offline.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })
        );
      }),
    );
  }
});
