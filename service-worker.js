/* Nexora Stay — service worker
   Caches the app shell (HTML/CSS/JS/icons) so the app opens instantly
   and works with zero network connection, even on a fresh device that
   hasn't been online since first install. The app's actual data
   already lives in localStorage (see app.js) — this only has to take
   care of the files needed to load the page itself.

   Bump CACHE_NAME whenever the shell files change so the next visit
   picks up the new version instead of serving a stale cached copy. */
const CACHE_NAME = 'nexora-stay-v1';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => {
          // Offline and not cached — for a page navigation, fall back
          // to the cached app shell rather than showing a browser error.
          if (event.request.mode === 'navigate') return caches.match('./index.html');
          return cached;
        });
      // Cache-first: serve instantly from cache if we have it, while
      // still updating the cache in the background for next time.
      return cached || networkFetch;
    })
  );
});
