// EggScore portal service worker — v2.
//
// IMPORTANT: the actual order page (famad-order.html) is NEVER cached
// and NEVER served from cache. Prices and stock change in real time,
// so showing a stale copy during an outage is worse than showing
// nothing — it risks a customer acting on a number that's already
// wrong. Every page navigation always hits the network. The only
// thing this service worker ever falls back to is a small static
// offline page with no live data on it at all.
//
// Static, non-price assets (icons, manifest, the offline page itself)
// are precached so the app shell still opens instantly.
const CACHE_NAME = 'eggscore-portal-v2';
const STATIC_SHELL = [
  '/manifest.json', '/icon-192.png', '/icon-512.png',
  '/favicon-32.png', '/favicon-48.png', '/apple-touch-icon.png',
  '/offline.html'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // Page navigations (opening/reloading the order form itself):
  // network-only, with the static offline page as the only fallback —
  // never a cached copy of the real page.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(resp => (resp && resp.ok) ? resp : caches.match('/offline.html'))
        .catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // Static shell assets only (icons, manifest) — safe to serve from
  // cache if the network genuinely fails, since none of these carry
  // pricing or stock data.
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
