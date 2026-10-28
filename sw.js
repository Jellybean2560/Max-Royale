const CACHE = 'max-royale-v6';
const SHELL = ['./', 'icon.png', 'manifest.json'];

// Card, evolution, hero and badge art lives on other hosts and is kept in its own
// cache, which app updates leave alone (only the shell cache is versioned).
// Served cache-first so reopening the app never waits on the network; each image
// is quietly re-checked every few days so new art at the same address replaces
// the stored copy. Art at a new address is simply a new entry; entries unused for
// IMG_UNUSED_MS are dropped. Those hosts send no CORS headers, so the responses
// are opaque: their status can't be read, and a failed download would be cached
// like a good one — the page reports images that fail to display ('img-broken')
// and they're deleted so the next view fetches them again.
const IMG_CACHE = 'max-royale-img-v1';
const IMG_HOSTS = ['api-assets.clashroyale.com', 'raw.githubusercontent.com'];
const IMG_RECHECK_MS = 3 * 24 * 60 * 60 * 1000;
const IMG_UNUSED_MS = 60 * 24 * 60 * 60 * 1000;
const IMG_MAX = 1000;
const IMG_META = './__img-meta';  // { url: { fetched, used } }, stored in IMG_CACHE

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

// Remove old caches, claim all clients, then reload open windows so users
// automatically get the new version without clearing browser data.
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE && k !== IMG_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.navigate(c.url));
    await pruneImages();
  })());
});

// ── Image cache bookkeeping ──
let metaPromise = null, savePromise = null, storedSincePrune = 0;
function loadMeta() {
  return metaPromise || (metaPromise = caches.open(IMG_CACHE)
    .then(c => c.match(IMG_META)).then(r => r ? r.json() : {}).catch(() => ({})));
}
// Batches bookkeeping writes; the returned promise keeps the worker alive until saved
function saveMeta() {
  return savePromise || (savePromise = new Promise(resolve => setTimeout(async () => {
    savePromise = null;
    try {
      const meta = await loadMeta();
      await (await caches.open(IMG_CACHE)).put(IMG_META, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    } catch (err) {}
    resolve();
  }, 2000)));
}
async function pruneImages() {
  const cache = await caches.open(IMG_CACHE), meta = await loadMeta(), now = Date.now();
  const drop = Object.keys(meta)
    .sort((a, b) => (meta[b].used || 0) - (meta[a].used || 0))
    .filter((u, i) => i >= IMG_MAX || now - (meta[u].used || 0) > IMG_UNUSED_MS);
  if (!drop.length) return;
  await Promise.all(drop.map(u => { delete meta[u]; return cache.delete(u); }));
  await saveMeta();
}

async function store(url, resp) {
  const cache = await caches.open(IMG_CACHE), meta = await loadMeta();
  await cache.put(url, resp);
  meta[url] = { fetched: Date.now(), used: Date.now() };
  if (++storedSincePrune >= 50) { storedSincePrune = 0; await pruneImages(); }
  await saveMeta();
}
// One download per URL at a time — the same card shows up in many decks at once.
// The page gets the image as soon as it arrives; storing it happens afterwards,
// kept alive by the fetch event. Callers clone the shared response.
const inflight = {};
function download(e, url, recheck) {
  return inflight[url] || (inflight[url] = (async () => {
    try {
      // A recheck bypasses the browser's HTTP cache freshness: with an ETag the
      // server answers "not modified" cheaply, otherwise it sends the new art.
      const resp = await fetch(url, { mode: 'no-cors', credentials: 'omit', cache: recheck ? 'no-cache' : 'default' });
      if (resp.type === 'opaque' || resp.ok) e.waitUntil(store(url, resp.clone()).catch(() => {}));
      return resp;
    } finally {
      delete inflight[url];
    }
  })());
}
async function imageResponse(e) {
  const url = e.request.url;
  const [hit, meta] = await Promise.all([caches.open(IMG_CACHE).then(c => c.match(url)), loadMeta()]);
  const now = Date.now();
  if (hit) {
    const m = meta[url] || (meta[url] = { fetched: 0 });  // fetched 0: recheck now
    m.used = now;
    if (now - m.fetched > IMG_RECHECK_MS) e.waitUntil(download(e, url, true).catch(() => {}));
    e.waitUntil(saveMeta());
    return hit;
  }
  return (await download(e, url, false)).clone();
}

self.addEventListener('message', e => {
  if (e.data?.type !== 'img-broken' || !e.data.url) return;
  e.waitUntil((async () => {
    const meta = await loadMeta();
    delete meta[e.data.url];
    await (await caches.open(IMG_CACHE)).delete(e.data.url);
    await saveMeta();
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
  if (req.method === 'GET' && req.destination === 'image' && req.mode === 'no-cors'
      && IMG_HOSTS.includes(new URL(req.url).hostname)) {
    // If the cache itself fails (storage full, evicted), just go to the network
    e.respondWith(imageResponse(e).catch(() => fetch(req)));
    return;
  }
  e.respondWith(caches.match(req).then(cached => cached || fetch(req)));
});
