#!/usr/bin/env node
/**
 * Ověří v SKUTEČNÉM prohlížeči, že se aplikace vyhrabe ze slepé uličky,
 * do které se dostala zařízení s cache z doby PŘED tlačítkem aktualizace.
 *
 * Postup (věrná reprodukce, proto se `sw.js` dočasně přepíše a v `finally`
 * vrátí — blob URL service worker nepřijme, protože scope nesmí být širší
 * než cesta skriptu):
 *   1. Nasadí se STARÝ `sw.js` (v5 — aktivuje se sám v `install`, jak to bylo
 *      před commitem a3da092) a stránka se z něj obslouží.
 *   2. Do jeho cache se podstrčí starý `index.html` — bez tlačítka
 *      a s `app.js?v=12`. Přesně to má takové zařízení uložené.
 *   3. Nasadí se zpět opravený `sw.js` a stránka se otevře ZNOVU.
 *   4. Ověří se, že zařízení vidí novou verzi (v22) bez kliknutí na cokoli.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const SW_PATH = join(DIR, '..', 'sw.js');
const NEW_SW = readFileSync(SW_PATH, 'utf8');

const PORT = Number(process.env.PORT || 9351);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + PORT);
const BASE = process.env.BASE || 'http://localhost:8123/';
mkdirSync(PROFILE, { recursive: true });

const OLD_SW = `/** Starý service worker (v5) — jen pro test záchrany. */
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('vocal-lab-v5').then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(h => h || fetch(e.request)));
});
`;

const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? '  — ' + d : ''}`); };

let ws;
try {
  for (let i = 0; i < 60; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch {}
    await sleep(250);
  }
  if (!ws) { console.error('CDP se nepřipojilo'); process.exit(1); }
  await new Promise(r => ws.onopen = r);

  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const evalJs = async (e, aw = false) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw });
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text) }; return r.result.value; };

  await send('Page.enable'); await send('Runtime.enable');
  setInterval(() => { send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }, 400);

  console.log('\n═══ Reprodukce: zařízení s cache z doby před tlačítkem ═══\n');

  /* ⚠️ Profil prohlížeče se mezi běhy DRŽÍ — zůstává v něm service worker
   * i cache z minula. Bez úklidu by se „starý" stav neobsloužil vůbec
   * (stránka by přišla z cache předchozího běhu) a test by prolomení slepé
   * uličky jen předstíral. Navíc `caches.match()` bez jména hledá ve VŠECH
   * cache, takže zbytek z minula ovlivní i to, co starý worker vrátí. */
  await send('Page.navigate', { url: BASE }); await sleep(2000);
  const clean = await evalJs(`(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
    const ks = await caches.keys();
    await Promise.all(ks.map(k => caches.delete(k)));
    return { unregistered: regs.length, deleted: ks.length };
  })()`, true);
  check('profil se vyčistil (žádný SW ani cache z minula)',
    clean && !clean.__err, clean && clean.__err ? clean.__err
      : `${clean && clean.unregistered} registrací, ${clean && clean.deleted} cache`);

  // ── 1. nasadit STARÝ sw.js ───────────────────────────────────────────────
  writeFileSync(SW_PATH, OLD_SW);
  await send('Page.navigate', { url: BASE }); await sleep(3000);

  const swState = await evalJs(`(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return { count: regs.length, controlled: !!navigator.serviceWorker.controller };
  })()`, true);
  check('starý service worker se zaregistroval a převzal stránku',
    swState && swState.count > 0 && swState.controlled,
    swState && swState.__err ? swState.__err : `${swState && swState.count} registrací`);

  // ── 2. podstrčit starou stránku do jeho cache ────────────────────────────
  /* ⚠️ Klíč je ADRESÁŘ (`/`), ne `index.html` — tak si service worker ukládá
   * navigaci a tak ji i hledá (`caches.match(e.request)`). Když se stará
   * stránka podstrčí pod `./index.html`, navigace ji mine a test pak
   * „prolomení slepé uličky" jen předstírá (přesně to se stalo napoprvé). */
  const stale = await evalJs(`(async () => {
    const html = await (await fetch('./index.html')).text();
    const old = html
      .replace(/<button id="btn-update"[\\s\\S]*?<\\/button>/, '')
      .replace(/app\\.js\\?v=\\d+/, 'app.js?v=12')
      .replace(/style\\.css\\?v=\\d+/, 'style.css?v=12');
    const c = await caches.open('vocal-lab-v5');
    const res = () => new Response(old, { headers: { 'content-type': 'text/html' } });
    await c.put('./', res());          // ← klíč navigace (adresář)
    await c.put('./index.html', res());
    return { hasBtn: /btn-update/.test(old), ver: (old.match(/app\\.js\\?v=(\\d+)/) || [])[1],
             keys: (await c.keys()).map(r => new URL(r.url).pathname) };
  })()`, true);
  check('do cache se podstrčila stará stránka (bez tlačítka, v12)',
    stale && stale.hasBtn === false && stale.ver === '12',
    stale && stale.__err ? stale.__err : `tlačítko v ní: ${stale && stale.hasBtn}, verze: ${stale && stale.ver}`);
  check('stará stránka je pod klíčem NAVIGACE (adresář), ne jen index.html',
    stale && stale.keys && stale.keys.includes('/'),
    stale && stale.keys ? stale.keys.join(', ') : '?');

  await send('Page.navigate', { url: BASE }); await sleep(2500);
  const served = await evalJs(`(() => ({
    hasBtn: !!document.getElementById('btn-update'),
    src: document.querySelector('script[src*="app.js"]') ? document.querySelector('script[src*="app.js"]').getAttribute('src') : '?',
  }))()`);
  check('výchozí stav: zařízení dostává stránku BEZ tlačítka (slepá ulička)',
    served && served.hasBtn === false && /v=12/.test(served.src || ''),
    served && served.__err ? served.__err : `tlačítko: ${served && served.hasBtn}, ${served && served.src}`);

  // ── 3. nasadit opravený sw.js a otevřít znovu ───────────────────────────
  writeFileSync(SW_PATH, NEW_SW);
  await send('Page.navigate', { url: BASE }); await sleep(4000);
  await send('Page.navigate', { url: BASE }); await sleep(3000);   // druhé otevření

  const after = await evalJs(`(async () => ({
    hasBtn: !!document.getElementById('btn-update'),
    appSrc: document.querySelector('script[src*="app.js"]') ? document.querySelector('script[src*="app.js"]').getAttribute('src') : '?',
    controlled: !!navigator.serviceWorker.controller,
    caches: await caches.keys(),
  }))()`, true);
  check('zařízení se dostalo k NOVÉ verzi bez kliknutí (slepá ulička prolomena)',
    after && /app\.js\?v=22/.test(after.appSrc || ''),
    after && after.__err ? after.__err : `app.js: ${after && after.appSrc}`);
  check('tlačítko aktualizace je k dispozici (ruční cesta zůstává)',
    after && after.hasBtn === true, `tlačítko: ${after && after.hasBtn}`);
  check('stará cache v5 se uklidila',
    after && after.caches && !after.caches.includes('vocal-lab-v5'),
    after && after.caches ? after.caches.join(', ') : '?');

  console.log(`\n${fail === 0 ? '✓' : '✗'} Záchrana v prohlížeči: ${pass} prošlo, ${fail} selhalo\n`);
} finally {
  // ⚠️ sw.js MUSÍ být vždy zpátky — jinak by v repu zůstal starý worker.
  writeFileSync(SW_PATH, NEW_SW);
  chrome.kill('SIGKILL');
}
process.exit(fail ? 1 : 0);
