/**
 * Service worker — offline provoz.
 * Verze cache zvyš při změně souborů, jinak se drží stará.
 */
const CACHE = 'vocal-lab-v20';

/**
 * Verze nasazeného buildu. Zvyšovat spolu s CACHE výše a s ?v= v index.html.
 * Vypisuje se v patičce aplikace, aby uživatel poznal, že aktualizace proběhla —
 * bez toho po kliknutí na tlačítko nemá jak zjistit, jestli se něco stalo.
 */
const APP_VERSION = '1.0.20';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './src/style.css',
  './src/app.js',
  './src/analysis.js',
  './src/sample-rate.js',
  // odhad zbývajícího času (čistá logika) — bez něj by offline režim
  // otevřel stránku, ale analýza by spadla na chybějícím modulu
  './src/progress.js',
  './src/charts.js',
  // analýza běží ve workeru — bez tohoto souboru by se analýza sice spustila
  // v hlavním vlákně, ale progress bar by zase zamrzl (viz analyze-worker.js)
  './src/analyze-worker.js',
  // živý režim — bez těchto souborů by offline režim otevřel stránku,
  // ale tlačítko Živě by spadlo na chybějícím modulu
  './src/live.js',
  './src/live-charts.js',
  './src/live-run.js',
  './src/live-ui.js',
  './src/dsp-backend.js',
  './wasm/build/dsp.wasm',
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
