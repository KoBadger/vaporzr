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

/* Web Push: show an alert (e.g. "YouTube cookies expired") and focus/open the panel. */
self.addEventListener('push', (event) => {
  let data = { title: 'Vaporzr', body: 'Update available', url: '/panel' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (err) {
    /* non-JSON payload — keep defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Vaporzr', {
      body: data.body || '',
      icon: '/logo.png',
      badge: '/logo.png',
      data: { url: data.url || '/panel' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/panel';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
