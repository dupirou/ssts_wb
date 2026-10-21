/* Offline support for stadium Wi-Fi and the subway: the schedule keeps opening without a network.
   Network first for everything, so nothing goes stale while online; the cache answers only when the
   network fails or takes longer than 4 s. The build stamps VERSION, which retires the old cache. */
const VERSION = 'fd103d4fd214';
const CACHE = 'ssts-' + VERSION;
const SHELL = ['./', './app.js', './site.css', './manifest.webmanifest', './icons/icon-192.png',
  './data/calendar.json', './data/updates.json'];
const SLOW_MS = 4000;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('ssts-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then(response => {
    if (response.ok && response.type === 'basic') cache.put(request, response.clone());
    return response;
  });
  network.catch(() => {}); // a late failure after the cache already answered is expected offline
  const slow = new Promise(resolve => setTimeout(resolve, SLOW_MS, null));
  const first = await Promise.race([network.catch(() => null), slow]);
  if (first) return first;
  // Every page is the same app shell, so any cached page serves a navigation.
  const cached = await cache.match(request, {ignoreSearch: request.mode === 'navigate'});
  return cached || network;
}

self.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
