// Bumping this version forces the old cache to be evicted on activate.
const CACHE = 'max-royale-v3';
const SHELL = ['./', 'icon.png', 'manifest.json'];

// Cache the app shell on install
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

// Remove old caches on activate
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for navigation / HTML so the user always gets the latest version
// when online, with cache fallback for offline. Cache-first for other assets.
self.addEventListener('fetch', e => {
  const req = e.request;
  const isNav = req.mode === 'navigate' ||
                (req.method === 'GET' && req.headers.get('accept')?.includes('text/html'));
  if (isNav) {
    e.respondWith(
      fetch(req).then(resp => {
        // Update the cached shell with the fresh copy
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(req).then(r => r || caches.match('./')))
    );
    return;
  }
  // Other assets: cache-first, fallback to network
  e.respondWith(caches.match(req).then(cached => cached || fetch(req)));
});
