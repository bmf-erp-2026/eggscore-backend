// EggScore ERP service worker (Oct 12 2026) — staff alerts ONLY.
//
// This worker does one job: when a customer sends a message about an order, the
// server pushes "New customer message" to staff devices that switched alerts on,
// and this worker shows it even when the ERP is closed. Tapping it opens the ERP
// (or brings an open ERP tab to the front) and opens that order's message box.
//
// It deliberately has NO fetch handler and caches nothing: the ERP page and its
// data always come straight from the network exactly as before. It is registered
// for the ERP page only (scope = the ERP's own address), so it never touches the
// customer portal, which has its own worker (service-worker.js).
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch(e) { data = { title: 'EggScore ERP', body: event.data ? event.data.text() : '' }; }
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/favicon-48.png',
    data: { url: data.url || '/famad-erp.html' },
  };
  if(data.tag) { options.tag = data.tag; options.renotify = true; }
  // Every push must show something (browsers penalise silent pushes).
  event.waitUntil(self.registration.showNotification(data.title || 'EggScore ERP', options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/famad-erp.html';
  let ref = null;
  try { ref = new URL(target, self.location.origin).searchParams.get('ordmsg'); } catch(e) {}
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for(const w of wins) {
      if(w.url.indexOf('/famad-erp') !== -1 && 'focus' in w) {
        // An ERP tab is already open: bring it forward and tell it which thread to open
        // (no reload, so nothing the staff member was doing is lost).
        await w.focus();
        if(ref) w.postMessage({ type: 'ordmsg-open', ref });
        return;
      }
    }
    if(self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
