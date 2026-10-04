/**
 * Service worker — offline provoz.
 * Verze cache zvyš při změně souborů, jinak se drží stará.
 */
const CACHE = 'vocal-lab-v25';

/**
 * Verze nasazeného buildu. Zvyšovat spolu s CACHE výše a s ?v= v index.html.
 * Vypisuje se v patičce aplikace, aby uživatel poznal, že aktualizace proběhla —
 * bez toho po kliknutí na tlačítko nemá jak zjistit, jestli se něco stalo.
 */
const APP_VERSION = '1.0.25';
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

/**
 * ⚠️ JEDNORÁZOVÁ ZÁCHRANA ZE SLEPÉ ULIČKY — po ověření se smí smazat.
 *
 * Tlačítko „zkontrolovat verzi" přišlo commitem `a3da092` SPOLU s cache v6.
 * Do té doby se service worker aktivoval sám (`skipWaiting()` v `install`)
 * a stránky byly cache-first. Zařízení, které si aplikaci uložilo dřív, má
 * proto v cache i STARÝ `index.html` se starým `app.js`, ve kterém žádné
 * tlačítko není — a od v6 nový worker záměrně čeká na zprávu `SKIP_WAITING`,
 * kterou umí poslat jen to tlačítko. Takové zařízení se z toho samo nevyhrabě:
 * drží starou stránku, ze které nelze aktualizaci spustit.
 *
 * Postup, který to vyřeší zevnitř SW (jediné místo, kam se ta zařízení dostanou):
 *  1. `install` — KDYŽ JE TO ZÁCHRANA (`RESCUE_UNTIL` ještě nevypršel),
 *     aktivovat se sám. Běží přitom souběžně se starým workerem, stránka se
 *     pořád načítá ze staré cache — nic se tedy nerozbije.
 *  2. Navigační požadavek („otevřel jsem aplikaci") se nově bere SÍŤOU
 *     a do cache se uloží až ta odpověď. Tím se nový `index.html` dostane na
 *     zařízení i bez reloadu řízeného stránkou.
 *  3. Ostatní assety zůstávají cache-first — kdyby se braly ze sítě, mohl by
 *     se nový `index.html` spárovat se starým `app.js` a spadlo by to.
 *     Obojí se aktualizuje společně při dalším načtení.
 *
 * PO VYPRŠENÍ `RESCUE_UNTIL` se blok sám přeskočí a chování je zpět na
 * ručním tlačítku (nová verze čeká na `SKIP_WAITING`). Tlačítko se NIKDY
 * neruší — proto `test-sw-update.mjs` pořád platí.
 *
 * Proč datum a ne „jen dokud je to potřeba": každé nasazení bumpuje CACHE,
 * takže by se záchrana musela explicitně vypnout stejným commitem jako něco
 * jiného — na to se zapomene. Datum se vypne samo.
 */
const RESCUE_UNTIL = Date.parse('2026-12-31T23:59:59Z');
const RESCUE = Date.now() < RESCUE_UNTIL;

/**
 * Nová verze se NEAKTIVUJE sama. Čeká, dokud ji o to nepožádá tlačítko
 * aktualizace v hlavičce (zpráva SKIP_WAITING). Kdyby se aktivovala hned,
 * převzala by kontrolu uprostřed rozehrané práce — a hlavně by se pak
 * nedalo poznat, že nějaká aktualizace vůbec čeká.
 *
 * Výjimka je jednorázová záchrana výše: když se uživatel ještě nedostane
 * k tlačítku (stará cache bez něj), aktivovat se musí.
 */
self.addEventListener('install', (e) => {
  const work = caches.open(CACHE).then(c => c.addAll(ASSETS));
  // ⚠️ `skipWaiting` smí být jen v TOMTO bloku (mutace: když se vrátí
  // bezpodmínečně, nová verze se aktivuje sama a tlačítko nemá co dělat).
  e.waitUntil(RESCUE ? work.then(() => self.skipWaiting()) : work);
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

/**
 * Navigace (otevření aplikace) se bere ze SÍTĚ, ostatní soubory z cache.
 *
 * PROČ: dokud byl i `index.html` cache-first, drželo zařízení navždy starou
 * stránku — nový worker sice mohl převzít kontrolu, ale stránka se načetla
 * ze staré cache, takže se v ní nic nezměnilo.
 *
 * ⚠️ Do cache se ukládá AŽ odpověď ze sítě, ne starý záznam předem — jinak by
 * se nový `index.html` nikdy neuložil a příští otevření offline by vrátilo
 * starou stránku.
 *
 * ⚠️ Jen navigace. Kdyby se i moduly (`app.js`, `charts.js`, `sw.js`) braly
 * ze sítě bez ohledu na cache, mohl by se nový `index.html` spárovat se
 * starým `app.js` (nesouhlasí `?v=`) a aplikace by spadla. Assety proto
 * zůstávají cache-first a vymění se společně s navigací při dalším načtení.
 *
 * ⚠️ Když je zařízení offline, musí se vrátit ULOŽENÁ stránka — ne chyba.
 * O to se stará `catch` níž.
 */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  // Navigace: nejdřív síť, při výpadku uložená stránka (offline režim).
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res && res.status === 200 && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // Ostatní: cache-first (offline režim stojí na tom, že assety jsou v cache).
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
