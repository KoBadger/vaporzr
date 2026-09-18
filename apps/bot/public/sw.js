/* Vaporzr panel service worker — deliberately cache-free. The control UI is
 * served no-store and iterated constantly, so caching would show stale state.
 * A fetch handler is required for installability; it just passes through. */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
});
