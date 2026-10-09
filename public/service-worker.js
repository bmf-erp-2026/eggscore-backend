// EggScore portal service worker — v3 (Oct 9 2026: adds push notifications).
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

// ── Push notifications (Oct 9 2026) ──────────────────────────────────────
// The backend (lib/push.js) sends a small JSON message
//   { title, body, url, tag, kind }
// to the customer's phone even when the portal is closed. This worker wakes
// up, shows it, and — if the customer taps it — opens (or re-focuses) the
// portal. Every push MUST show a visible notification (browsers, Safari in
// particular, penalise silent pushes), which is why showNotification is
// always called.
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch(e) {
    data = { title: 'EggScore', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'EggScore';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/favicon-48.png',
    data: { url: data.url || '/famad-order.html' },
  };
  // A tag makes a newer message replace an older one of the same kind
  // (e.g. "confirmed" is replaced by "on its way" for the same order)
  // instead of stacking up on the lock screen.
  if(data.tag) { options.tag = data.tag; options.renotify = true; }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/famad-order.html';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for(const w of wins) {
      if(w.url.indexOf('/famad-order.html') !== -1 && 'focus' in w) {
        return w.focus();
      }
    }
    if(self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
