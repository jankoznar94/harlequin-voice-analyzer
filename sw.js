/**
 * Service worker — offline provoz.
 * Verze cache zvyš při změně souborů, jinak se drží stará.
 */
const CACHE = 'vocal-lab-v7';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './src/style.css',
  './src/app.js',
  './src/analysis.js',
  './src/charts.js',
];

// Nová verze se NEAKTIVUJE sama. Čeká, dokud ji o to nepožádá tlačítko
// aktualizace v hlavičce (zpráva SKIP_WAITING). Kdyby se aktivovala hned,
// převzala by kontrolu uprostřed rozehrané práce — a hlavně by se pak
// nedalo poznat, že nějaká aktualizace vůbec čeká.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        // necachovat cross-origin
        if (!res || res.status !== 200 || new URL(e.request.url).origin !== location.origin) {
          return res;
        }
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
