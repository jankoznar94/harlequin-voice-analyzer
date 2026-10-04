#!/usr/bin/env node
/**
 * Test SERVICE WORKERU — spouští SKUTEČNÝ `sw.js` v mocku (jako test-playhead
 * spouští skutečný charts.js). Headless Chromium v tomto prostředí service
 * workery nespouští, takže jiná cesta než mock není.
 *
 * Hlídá tři věci, které se v této logice pokazí nejčastěji:
 *
 *  1. **Záchrana ze slepé uličky.** Zařízení s cache v1–v5 mají starý
 *     `index.html` BEZ tlačítka aktualizace a nový worker od v6 čeká na
 *     `SKIP_WAITING`, který umí poslat jen to tlačítko. Takové zařízení se
 *     samo nevyhrabě — proto se v záchranářském okně worker aktivuje sám
 *     (`skipWaiting` v `install`). ⚠️ Mutace: jakmile se `skipWaiting` vrátí
 *     BEZ podmínky, záchrana se změní v trvalý stav a tlačítko ztratí smysl —
 *     test to musí shodit.
 *
 *  2. **Navigace se bere SÍTÍ, ostatní assety z cache.** Dokud byl
 *     `index.html` cache-first, načetla se pořád stará stránka a na zařízení
 *     se nikdy nic nezměnilo. Ale moduly ze sítě bez ohledu na cache by
 *     spárovaly nový `index.html` se starým `app.js` (nesouhlasí `?v=`)
 *     a aplikace by spadla — proto musí zůstat cache-first.
 *
 *  3. **Offline nesmí vrátit chybu.** Když je zařízení bez sítě, navigace
 *     musí dát ULOŽENOU stránku.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SW_SRC = fs.readFileSync(path.join(DIR, '..', 'sw.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

const BASE = 'http://localhost:8123/harlequin-voice-analyzer/';
const abs = (u) => (u.startsWith('http') ? u : new URL(u, BASE).href);
const keyOf = (req) => abs(typeof req === 'string' ? req : req.url);

/**
 * Spustí skutečný sw.js v mocku a vrátí zachycené handlery + stav cache.
 * @param {object} o  { now, netFail, cached }
 */
function runSW(o = {}) {
  const now = o.now ?? Date.now();
  const store = new Map();          // url → odpověď (obsah cache)
  for (const [u, body] of Object.entries(o.cached || {})) store.set(abs(u), body);
  const cacheNames = new Set(o.cacheNames || []);
  let puts = 0;

  const mkRes = (url, body, status = 200) => ({
    status, url: abs(url), body,
    clone() { return mkRes(url, body, status); },
  });

  const cache = {
    async addAll(urls) { for (const u of urls) if (!store.has(abs(u))) store.set(abs(u), mkRes(u, 'precached')); },
    async put(req, res) { puts++; store.set(keyOf(req), res); },
    async match(req) { return store.get(keyOf(req)) || undefined; },
  };
  const caches = {
    async open() { return cache; },
    async match(req) { return store.get(keyOf(req)) || undefined; },
    async keys() { return [...cacheNames]; },
    async delete(n) { cacheNames.delete(n); return true; },
  };
  const fetchCalls = [];
  const fetchMock = async (req) => {
    fetchCalls.push(keyOf(req));
    if (o.netFail) throw new Error('offline');
    return mkRes(keyOf(req), 'network:' + keyOf(req));
  };
  const claims = [], skips = [];
  const handlers = {};
  const self = {
    addEventListener: (t, fn) => { handlers[t] = fn; },
    skipWaiting: () => skips.push(1),
    clients: { claim: () => { claims.push(1); return Promise.resolve(); } },
    location: { origin: new URL(BASE).origin },
  };
  const FakeDate = { parse: Date.parse, now: () => now };

  // Skutečný sw.js — nic se nekopíruje.
  const fn = new Function('self', 'caches', 'fetch', 'location', 'URL', 'Date', SW_SRC);
  fn(self, caches, fetchMock, self.location, URL, FakeDate);

  /** Zavolá handler a počká na jeho waitUntil/respondWith. */
  const fire = async (type, event) => {
    let waited = null, responded = null;
    handlers[type]({ waitUntil: (p) => { waited = p; }, respondWith: (p) => { responded = p; }, ...event });
    if (waited) await waited;
    if (responded) return await responded;
    return undefined;
  };

  return {
    store, cacheNames, fetchCalls, claims, skips, puts, fire, handlers,
    has: (u) => store.has(abs(u)),
    get: (u) => store.get(abs(u)),
    req: (url, mode = 'cors') => ({ url: abs(url), method: 'GET', mode }),
  };
}

console.log('\n═══ Service worker: záchrana ze slepé uličky ═══\n');

/* Záchranářské okno musí být OTEVŘENÉ, jinak testy níž testují vypnutou
 * větev a nikdo si toho nevšimne. Až vyprší, tenhle test to řekne a blok
 * s RESCUE_UNTIL se má z sw.js smazat. */
{
  const until = Date.parse((SW_SRC.match(/RESCUE_UNTIL = Date\.parse\('([^']+)'\)/) || [])[1]);
  check('sw.js má ohraničené záchranářské okno (RESCUE_UNTIL)',
    Number.isFinite(until), new Date(until).toISOString());
  check('záchranářské okno je ještě otevřené (jinak se blok smí smazat)',
    Date.now() < until, `do ${new Date(until).toISOString()}`);
}

{
  // (a) uvnitř okna se worker aktivuje sám
  const sw = runSW({ now: Date.parse('2026-10-04T12:00:00Z'), cacheNames: ['vocal-lab-v5'] });
  await sw.fire('install', {});
  check('v záchranářském okně se worker aktivuje sám', sw.skips.length === 1,
    `${sw.skips.length}× skipWaiting`);
  check('přitom se stáhly všechny assety',
    sw.has('./index.html') && sw.has('./src/app.js') && sw.has('./wasm/build/dsp.wasm'),
    `${sw.store.size} položek v cache`);
}
{
  // (b) po okně se NEaktivuje sám — jinak by tlačítko nemělo co dělat
  const sw = runSW({ now: Date.parse('2027-06-01T12:00:00Z') });
  await sw.fire('install', {});
  check('po vypršení okna se worker sám NEaktivuje (čeká na tlačítko)',
    sw.skips.length === 0, `${sw.skips.length}× skipWaiting`);
  check('assety se stáhnou i tak', sw.has('./index.html'));
}
{
  // (c) mutační pojistka: skipWaiting nesmí být bezpodmínečný
  check('skipWaiting je vázaný na podmínku (ne bezpodmínečně)',
    /RESCUE \? .*skipWaiting|if \(RESCUE\)[\s\S]{0,80}skipWaiting/.test(SW_SRC),
    'musí být `RESCUE ? … skipWaiting()` — ne volání napřímo');
}

console.log('\n═══ Service worker: navigace ze sítě, assety z cache ═══\n');

{
  // (a) nová stránka ze sítě se ULOŽÍ do cache (jinak by offline vracelo starou)
  const sw = runSW({ cached: { './index.html': { status: 200, body: 'STARA-STRANKA' } } });
  const res = await sw.fire('fetch', { request: sw.req('./index.html', 'navigate') });
  check('navigace se bere ze sítě (ne ze staré cache)',
    res.body === 'network:' + abs('./index.html'), String(res.body));
  check('odpověď ze sítě se ULOŽÍ do cache (ne stará)',
    sw.get('./index.html').body.startsWith('network:'),
    String(sw.get('./index.html').body).slice(0, 40));
}
{
  // (b) offline: musí vrátit ULOŽENOU stránku, ne chybu
  const sw = runSW({ netFail: true, cached: { './index.html': { status: 200, body: 'STARA-STRANKA' } } });
  const res = await sw.fire('fetch', { request: sw.req('./index.html', 'navigate') });
  check('offline navigace vrátí uloženou stránku (žádná chyba)',
    res && res.body === 'STARA-STRANKA', res ? String(res.body) : 'undefined');
}
{
  // (c) modul v cache se bere z cache — na tom stojí offline režim
  const sw = runSW({ cached: { './src/app.js': { status: 200, body: 'APP-Z-CACHE' } } });
  const res = await sw.fire('fetch', { request: sw.req('./src/app.js') });
  check('modul se bere z cache (offline režim)', res.body === 'APP-Z-CACHE', String(res.body));
  check('u modulu z cache se nesahá na síť', sw.fetchCalls.length === 0,
    `${sw.fetchCalls.length} volání fetch`);
}
{
  // (d) modul, který v cache není, se stáhne a uloží
  const sw = runSW({});
  const res = await sw.fire('fetch', { request: sw.req('./src/charts.js') });
  check('modul mimo cache se stáhne ze sítě', sw.fetchCalls.length === 1, res.body);
  check('a uloží se do cache pro offline', sw.get('./src/charts.js') !== undefined);
}
{
  // (e) ⚠️ moduly se NESMÍ brát ze sítě bez ohledu na cache: nový index.html
  // se starým app.js (jiné ?v=) by aplikaci shodil.
  const sw = runSW({ cached: { './src/app.js': { status: 200, body: 'STARY-APP' } } });
  const res = await sw.fire('fetch', { request: sw.req('./src/app.js') });
  check('starý modul v cache se NEpřepíše novým ze sítě (parita ?v=)',
    res.body === 'STARY-APP' && sw.fetchCalls.length === 0, String(res.body));
}

console.log('\n═══ Service worker: úklid a ruční aktualizace ═══\n');

{
  /* Verze cache se bere ze SKUTEČNÉHO sw.js — jinak test selže při každém
   * bumpnutí cache, i když je kód v pořádku (přesně to se stalo: test měl
   * natvrdo v22, po bumpu na v24 hlásil „aktivace nesmazala staré cache“).
   * Test, který si verzi opíše ručně, hlídá datum, ne chování. */
  const curCache = (SW_SRC.match(/const CACHE = '([^']+)'/) || [])[1];
  const stale = ['vocal-lab-v5', 'vocal-lab-v21', 'vocal-lab-v22', 'vocal-lab-v23']
    .filter(n => n !== curCache);
  /* Aktuální cache se do stavu PŘIDÁ: v běžícím prohlížeči ji před aktivací
   * vytvořil `install` (`cache.addAll(ASSETS)`), kdežto `activate` sám žádnou
   * nevytváří — jen maže cizí. Kdyby v mocku chyběla, zůstane po aktivaci
   * prázdno a test hlásí „nesmazal staré“, i když kód maže správně. */
  const sw = runSW({ cacheNames: [...stale, curCache] });
  await sw.fire('activate', {});
  /* Aktuální cache musí ZŮSTAT (bez ní by offline režim neměl odkud vzít
   * soubory), staré se smažou — jinak by zařízení drželo i obsah z v1–v5. */
  const left = [...sw.cacheNames];
  check('aktivace smaže staré cache a aktuální nechá',
    left.length === 1 && left[0] === curCache, left.join(', ') || 'žádné');
  check('aktivace převezme kontrolu nad stránkou', sw.claims.length === 1);
}
{
  const sw = runSW({});
  const msg = sw.fire('message', { data: { type: 'SKIP_WAITING' } });
  await msg;
  check('zpráva SKIP_WAITING aktivuje worker (tlačítko funguje dál)', sw.skips.length === 1);
}
{
  const sw = runSW({});
  await sw.fire('message', { data: { type: 'NĚCO_JINÉHO' } });
  check('jiná zpráva worker neaktivuje', sw.skips.length === 0);
}
{
  const sw = runSW({});
  await sw.fire('fetch', { request: { url: abs('./'), method: 'POST', mode: 'navigate' } });
  check('POST se service workerem neprochází', sw.fetchCalls.length === 0);
}

console.log(`\n${fail === 0 ? '✓' : '✗'} Service worker: ${pass} prošlo, ${fail} selhalo\n`);
process.exit(fail ? 1 : 0);
