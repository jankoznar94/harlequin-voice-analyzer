/**
 * Service worker — offline provoz.
 * Verze cache zvyš při změně souborů, jinak se drží stará.
 */
const CACHE = 'vocal-lab-v38';

/**
 * Verze nasazeného buildu. Zvyšovat spolu s CACHE výše a s ?v= v index.html.
 * Vypisuje se v patičce aplikace, aby uživatel poznal, že aktualizace proběhla —
 * bez toho po kliknutí na tlačítko nemá jak zjistit, jestli se něco stalo.
 */
const APP_VERSION = '1.0.38';
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
  // živý spektrogram — čistá logika sloupce a jeho normalizace
  './src/live-spec.js',
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
 * ⚠️ VŠECHNO SE BERE Z CACHE (i navigace) A HLEDÁ SE I BEZ `?v=`.
 *
 * Tady vznikala reálná vada: `index.html` se bral ze SÍTĚ, ale moduly
 * (`src/live-ui.js` atd.) cache-first. Po nasazení se tak na zařízení potkala
 * NOVÁ stránka se STARÝMI moduly a živý spektrogram zůstal prázdné okno:
 * staré `live-ui.js` o plátně `c-live-spec` vůbec nevědělo. Naměřeno
 * (`test/test-sw-mix.mjs`): stránka si vyžádala `app.js?v=37` (79770 B, nový),
 * ale dostala `live-ui.js` 7181 B a `live-charts.js` 16336 B — přesně
 * velikosti z předchozí verze, zatímco nové mají 8153 a 29994. Plátno mělo
 * 0 nakreslených pixelů, a přitom tón i úroveň šly normálně. Bez chyby
 * v konzoli.
 *
 * Druhá polovina téže vady: `index.html` žádá `src/app.js?v=37`, ale `ASSETS`
 * ukládá `./src/app.js` BEZ query — takže se takový požadavek v cache nikdy
 * netrefil a `app.js` i `style.css` chodily vždy ze sítě. Proto se hledá
 * s `ignoreSearch: true`: jeden požadavek = jedna verze souboru z JEDNÉ cache,
 * ať je v adrese query jakákoli. Nemusí se proto hlídat, že `?v=` sedí
 * s klíčem v `ASSETS` — na tuhle past se nedá zapomenout.
 *
 * Cache-first drží stav KONZISTENTNÍ: buď je všechno staré, nebo všechno nové.
 * Novou verzi dostane uživatel tlačítkem aktualizace v hlavičce (pošle
 * `SKIP_WAITING`, nový worker se aktivuje a stránka se znovu načte z nové
 * cache) — to je zavedená a otestovaná cesta (`test-sw-update.mjs`).
 *
 * Dřívější důvod pro navigaci ze sítě („doručit nový index.html sám") už
 * pominul: jednorázová záchrana mířila na zařízení s cache STARŠÍ než v6,
 * která tlačítko vůbec neměla. Taková zařízení jsou dávno pryč a `RESCUE_UNTIL`
 * navíc sám vyprší. Konzistence verzí je důležitější.
 *
 * Offline režim tím zůstává: `caches.match` vrátí uloženou stránku.
 */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        // necachovat cross-origin
        if (!res || res.status !== 200 || new URL(e.request.url).origin !== location.origin) {
          return res;
        }
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match('./index.html', { ignoreSearch: true }));
    })
  );
});
