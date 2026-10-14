// Service worker: cache do app shell (stale-while-revalidate).
// Chamadas à API (outro domínio) não passam por aqui.
const CACHE = 'despesas-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  ev.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const chave = req.mode === 'navigate' ? './index.html' : req;
      const emCache = await cache.match(chave, { ignoreSearch: req.mode === 'navigate' });
      const daRede = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(chave, res.clone());
          return res;
        })
        .catch(() => emCache);
      return emCache || daRede;
    })
  );
});
