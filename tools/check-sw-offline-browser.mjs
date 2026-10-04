#!/usr/bin/env node
/**
 * Ověří v SKUTEČNÉM prohlížeči, že OFFLINE REŽIM dál funguje.
 *
 * Navigace se nově bere ze sítě (aby se zařízení dostalo z cache, která držela
 * starou stránku navždy). To je zásah do chování, na kterém stojí offline
 * režim — bez sítě se MUSÍ vrátit uložená stránka, ne chyba prohlížeče.
 *
 * Postup: načti aplikaci (ať se cache naplní), pak přepni síť OFFLINE
 * a znovu naviguj. Stránka musí naběhnout z cache.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 9352);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + PORT);
const BASE = process.env.BASE || 'http://localhost:8123/';
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
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

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
setInterval(() => { send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }, 400);

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? '  — ' + d : ''}`); };

console.log('\n═══ Offline režim po změně navigace na síť ═══\n');

await send('Page.navigate', { url: BASE }); await sleep(3000);
const clean = await evalJs(`(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map(r => r.unregister()));
  const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k)));
  return true;
})()`, true);
check('profil vyčištěn', clean === true);

// online: cache se má naplnit
await send('Page.navigate', { url: BASE }); await sleep(3500);
const online = await evalJs(`(async () => ({
  hasBtn: !!document.getElementById('btn-update'),
  controlled: !!navigator.serviceWorker.controller,
  caches: await caches.keys(),
  cached: !!(await caches.match('./')),
}))()`, true);
check('online: aplikace naběhla a je pod kontrolou service workeru',
  online && online.controlled && online.caches.length > 0,
  online && online.__err ? online.__err : `cache: ${online && online.caches}`);
check('online: stránka se uložila do cache (klíč navigace)',
  online && online.cached === true, `uloženo: ${online && online.cached}`);

// ── OFFLINE ────────────────────────────────────────────────────────────────
/* ⚠️ SAMOTNÉ `offline: true` NESTAČÍ a ani `Network.setCacheDisabled` nezaručí,
 * že navigaci obslouží service worker — Chromium má vlastní vrstvy cache
 * (ověřeno mutací: i s rozbitým fallbackem v sw.js se stránka offline načetla).
 * Tenhle test proto dokazuje JEN to, co uživatel opravdu vidí: že se aplikace
 * offline NAČTE. Větev s `catch` ve `sw.js` (návrat uložené stránky) hlídá
 * `test/test-sw-rescue.mjs` v mocku — a tu mutace shodí. Neslibovat víc,
 * než co test umí ověřit. */
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
});
await send('Page.navigate', { url: BASE }); await sleep(3500);

const off = await evalJs(`(() => ({
  url: location.href,
  title: document.title,
  hasBtn: !!document.getElementById('btn-update'),
  bodyLen: document.body ? document.body.innerHTML.length : 0,
  err: window.__err || null,
}))()`);
check('offline: aplikace se uživateli NAČTE (ne chybová stránka)',
  off && off.bodyLen > 500, off && off.__err ? off.__err : `délka obsahu ${off && off.bodyLen}`);
check('offline: naběhla právě aplikace', off && off.hasBtn === true && /analýz|hlas/i.test(off.title || ''),
  off ? `titulek „${off.title}"` : '?');

// offline i u assetu, který v cache JE (na tom offline režim stojí)
const offAsset = await evalJs(`(async () => {
  try {
    const r = await fetch('./src/charts.js');
    const t = await r.text();
    return { ok: r.ok, len: t.length };
  } catch (e) { return { err: String(e) }; }
})()`, true);
check('offline: modul se dá vzít z cache (offline režim běží dál)',
  offAsset && offAsset.ok && offAsset.len > 1000,
  offAsset && offAsset.err ? offAsset.err : `${offAsset && offAsset.len} znaků`);

await send('Network.emulateNetworkConditions', {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});

console.log(`\n${fail === 0 ? '✓' : '✗'} Offline režim: ${pass} prošlo, ${fail} selhalo\n`);
chrome.kill('SIGKILL');
process.exit(fail ? 1 : 0);
