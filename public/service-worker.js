/* Nexora Stay — service worker
   Caches the app shell (HTML/CSS/JS/icons) so the app opens and works with
   zero network connection, even on a device that hasn't been online since it
   was installed. The app's data already lives in localStorage (see app.js);
   this only takes care of the files needed to load the page itself.

   Rules, deliberately conservative:
   - Calls to the backend (/.netlify/…, or anything carrying the sync key)
     are NEVER intercepted or cached. Caching them made the app show an old
     copy of the backend's answer — e.g. expenses that had already synced
     would look missing.
   - The app itself is "network first": while online you always get the
     newest version (so updates and fixes arrive immediately); the cached
     copy is only used when the network is unavailable or very slow.

   Bump CACHE_NAME whenever the shell files change. */
const CACHE_NAME = 'nexora-stay-v4';
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
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (response && response.status === 200) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;       // fonts and other sites: browser handles them
  if (url.pathname.indexOf('/.netlify/') === 0) return;  // backend calls always go straight to the network
  if (request.headers.has('authorization')) return;      // anything carrying the sync key
  event.respondWith(networkFirst(request));
});
