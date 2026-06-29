const CACHE = 'max-royale-v4';
const SHELL = ['./', 'icon.png', 'manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

// Remove old caches, claim all clients, then reload open windows so users
// automatically get the new version without clearing browser data.
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.navigate(c.url));
  })());
});

// Network-first for navigation so the user always gets the latest HTML.
// Use cache: 'no-cache' to bypass the GitHub Pages CDN HTTP cache as well.
self.addEventListener('fetch', e => {
  const req = e.request;
  const isNav = req.mode === 'navigate' ||
                (req.method === 'GET' && req.headers.get('accept')?.includes('text/html'));
  if (isNav) {
    e.respondWith(
      fetch(new Request(req, { cache: 'no-cache' })).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(req).then(r => r || caches.match('./')))
    );
    return;
  }
  e.respondWith(caches.match(req).then(cached => cached || fetch(req)));
});
