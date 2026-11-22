/* DinkHub service worker. Registered ONLY by the referee page.
   It never touches admin/operator pages, and never caches Firebase data or auth calls. */
const VERSION = "dinkhub-v2";
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;

const SHELL_FILES = [
  "./index.html",
  "./referee/referee.html",
  "./firebase-config.js",
  "./pwa.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// Third-party static assets that are safe to cache so the app shell opens offline.
const CDN_HOSTS = [
  "cdn.tailwindcss.com",
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

// Hosts with clean URLs (e.g. Vercel cleanUrls) answer /x.html with a redirect. Browsers refuse to
// serve a "redirected" response to a page navigation, so store a clean copy instead.
async function clean(res) {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

const isPrivatePage = (url) => /\/(admin|operator)\//.test(url.pathname);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.allSettled(SHELL_FILES.map(async (f) => {
        const res = await fetch(f);
        if (res.ok) await c.put(f, await clean(res));
      })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) { const copy = await clean(fresh.clone()); cache.put(request, copy); }
    return fresh;
  } catch (err) {
    return (await cache.match(request, { ignoreSearch: true })) || (await cache.match("./referee/referee.html")) || Response.error();
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then(async (res) => { if (res.ok || res.type === "opaque") cache.put(request, await clean(res.clone())); return res; })
    .catch(() => null);
  return cached || (await refresh) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (isPrivatePage(url)) return;                       // admin + operator: always straight to network
    if (req.mode === "navigate") { event.respondWith(networkFirst(req)); return; }
    event.respondWith(staleWhileRevalidate(req, SHELL));
    return;
  }

  // Firebase SDK files (code only; not the API/auth/database calls).
  const isFirebaseSdk = url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  if (isFirebaseSdk || CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME));
  }
  // Anything else (Firebase Auth, Realtime Database, etc.) is left to the network.
});