#!/usr/bin/env node
/**
 * KONZISTENCE VERZÍ po nasazení — živý spektrogram v prázdném okně.
 *
 * Reálná vada, kterou tenhle test chytá: `index.html` se bral ze SÍTĚ, ale
 * moduly (`src/*.js`) cache-first. Po nasazení se na zařízení potkala NOVÁ
 * stránka se STARÝMI moduly a živý spektrogram zůstal prázdné okno — staré
 * `live-ui.js` o plátně `c-live-spec` vůbec nevědělo. Naměřeno: stránka
 * dostala `app.js?v=37` (79770 B, nový) a k tomu `live-ui.js` 7181 B
 * a `live-charts.js` 16336 B (přesně velikosti z předchozí verze, kdežto
 * nové mají 8153 a 29994). Plátno mělo 0 nakreslených pixelů, a přitom tón
 * i úroveň šly normálně. Bez chyby v konzoli.
 *
 * Test naservíruje STAROU verzi, nechá ji zacachovat, pak „nasadí" novou
 * a měří, co zařízení dostane. Hlídá dvě věci:
 *   1. po převzetí nového workera je sada Z JEDNÉ VERZE (žádná směs),
 *   2. živý spektrogram po aktualizaci opravdu kreslí (ne jen že soubory sedí).
 *
 * Použití: node test/test-sw-mix.mjs
 * (vyžaduje chromium-browser; když není, test se přeskočí, ne selže)
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 8181, CDP_PORT = 9381;
const WORK = process.env.HOME + '/.cache/va-sw-mix';
const A = path.join(WORK, 'stara');     // co má zařízení v cache
const B = path.join(WORK, 'nova');      // co je „na serveru"
const PROFILE = path.join(WORK, 'profil');
const STARA_REV = '5313caf';            // v36 — před živým spektrogramem
const NOVA_REV = '611e351';             // v37 — se živým spektrogramem

const haveChrome = spawnSync('which', ['chromium-browser'], { encoding: 'utf8' }).status === 0;
if (!haveChrome) {
  console.log('\n⏭  chromium-browser není k dispozici — test přeskočen.\n');
  process.exit(0);
}

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ── dva buildy z gitu ───────────────────────────────────────────────────── */

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const tar = (rev, dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const buf = execFileSync('git', ['archive', rev], { cwd: ROOT, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', dir], { input: buf });
};
tar(STARA_REV, A);
tar(NOVA_REV, B);
/* Do nové verze se přeleje PRACOVNÍ STROM: oprava service workeru ještě není
 * v žádném commitu, takže bez toho by test měřil starý kód a padal pořád. */
fs.copyFileSync(path.join(ROOT, 'sw.js'), path.join(B, 'sw.js'));
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(B, 'index.html'));

/* ── server, jehož obsah se dá „nasadit" přepnutím ───────────────────────── */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm' };
let current = A;
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new globalThis.URL(req.url, 'http://x').pathname);
  const file = path.join(current, p === '/' ? 'index.html' : p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});
await new Promise(r => server.listen(PORT, r));

/* ── prohlížeč se SKUTEČNÝM service workerem ─────────────────────────────── */

fs.mkdirSync(PROFILE, { recursive: true });
const chrome = spawn('chromium-browser', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${path.join(ROOT, 'rec-test/zpev.wav')}`,
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const p = list.find(t => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch { /* ještě neběží */ }
  await sleep(250);
}
if (!ws) {
  console.error('CDP se nepřipojilo');
  server.close(); chrome.kill('SIGKILL'); process.exit(1);
}
await new Promise(r => ws.onopen = r);

let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails
    ? { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0] }
    : r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Browser.grantPermissions', { origin: `http://localhost:${PORT}`, permissions: ['audioCapture'] }).catch(() => {});

const APP_URL = `http://localhost:${PORT}/index.html`;

/**
 * Co service worker SKUTEČNĚ servíruje — ne co je na serveru, ale co dostane
 * stránka. Tohle je rozdíl, který celou vadu odhalil.
 * v36: live-ui 7181 B (o spektrogramu neví), live-charts 16336 B
 * v37: live-ui 8153 B, live-charts 29994 B
 */
const servovanaSada = () => js(`(async () => {
  const g = async (u) => (await fetch(u)).text();
  const html = await g('./index.html');
  const ui = await g('./src/live-ui.js');
  const ch = await g('./src/live-charts.js');
  return {
    htmlMaPlatno: html.includes('c-live-spec'),
    uiZnaSpektrogram: ui.includes('live-spec'),
    uiDelka: ui.length,
    chartsZnaSpektrogram: ch.includes('drawLiveSpec'),
    chartsDelka: ch.length,
  };
})()`);

console.log('\n═══ Zařízení se starou cache + nasazená nová verze ═══\n');

/* ── 1. první otevření: zařízení si uloží starou verzi ───────────────────── */

await send('Page.navigate', { url: APP_URL });
await sleep(4500);
console.log('  po prvním otevření:', JSON.stringify(await js(`(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return { aktivni: r && r.active ? r.active.scriptURL : null, caches: await caches.keys() };
})()`)));
ok('service worker se zaregistroval a převzal kontrolu',
  !!(await js(`navigator.serviceWorker.controller !== null`)));

const sadaStara = await servovanaSada();
console.log('  servírovaná sada (stará):', JSON.stringify(sadaStara));
ok('stará verze opravdu NEZNÁ živý spektrogram (past je reálná)',
  sadaStara.htmlMaPlatno === false && sadaStara.uiZnaSpektrogram === false,
  `plátno ${sadaStara.htmlMaPlatno}, zná spektrogram ${sadaStara.uiZnaSpektrogram}`);

/* ── 2. nasazení nové verze ──────────────────────────────────────────────── */

current = B;
console.log('\n  → na serveru je teď nová verze, uživatel appku otevře znovu\n');
await send('Page.navigate', { url: APP_URL });
await sleep(4000);
console.log('  po nasazení:', JSON.stringify(await js(`(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return { cekajici: !!(r && r.waiting), caches: await caches.keys() };
})()`)));

/* ── 3. převzetí nového workera (tlačítko aktualizace) ───────────────────── */

console.log('\n  → klik na tlačítko aktualizace\n');
await js(`document.getElementById('btn-update')?.click()`);
await sleep(8000);
console.log('  cache:', JSON.stringify(await js(`caches.keys()`)));

const sadaNova = await servovanaSada();
console.log('  servírovaná sada (nová):', JSON.stringify(sadaNova));

ok('stránka i oba moduly jsou Z JEDNÉ VERZE (žádná směs)',
  sadaNova.htmlMaPlatno === true && sadaNova.uiZnaSpektrogram === true && sadaNova.chartsZnaSpektrogram === true,
  `html ${sadaNova.htmlMaPlatno}, ui ${sadaNova.uiZnaSpektrogram}, charts ${sadaNova.chartsZnaSpektrogram}`);
/* Pozor: `text().length` jsou ZNAKY (UTF-16), ne bajty — české soubory mají
 * znaků méně než bajtů. Srovnává se proto s naměřenými hodnotami ve znacích,
 * a hlavně MEZI SEBOU (stará vs nová), což je to, co má význam. */
ok('a moduly jsou delší než stará verze (nová přidala spektrogram)',
  sadaNova.uiDelka > sadaStara.uiDelka && sadaNova.chartsDelka > sadaStara.chartsDelka,
  `live-ui ${sadaStara.uiDelka} → ${sadaNova.uiDelka} znaků, ` +
  `live-charts ${sadaStara.chartsDelka} → ${sadaNova.chartsDelka} znaků`);

/* ── 4. a hlavně: živý spektrogram musí KRESLIT ─────────────────────────── */

/* ── 3b. první načtení po nasazení ještě obsluhoval STARÝ worker ──────────
 *
 * To je nevyhnutelné: dokud běží starý SW (s navigací ze sítě), vznikne směs
 * ještě než se nový kód vůbec dostane ke slovu. Oprava působí od chvíle, kdy
 * nový worker převezme kontrolu — a to je přesně to, co se tady měří.
 * Nové načtení (co udělá tlačítko aktualizace) proto musí dát KONZISTENTNÍ
 * sadu. */
console.log('\n  → nové načtení už pod novým workerem\n');
await send('Page.navigate', { url: APP_URL });
await sleep(4000);

const sadaPoReloadu = await servovanaSada();
const spustenePoReloadu = await js(`
  performance.getEntriesByType('resource')
    .filter(e => /live-|app\.js/.test(e.name))
    .map(e => e.name.split('/').pop() + '=' + e.decodedBodySize)`);
console.log('  moduly spuštěné po novém načtení:', JSON.stringify(spustenePoReloadu));
console.log('  servírovaná sada:', JSON.stringify(sadaPoReloadu));

ok('po načtení pod novým workerem má stránka i moduly JEDNU verzi',
  spustenePoReloadu.some(x => x.startsWith('live-ui.js=8153')) &&
  spustenePoReloadu.some(x => x.startsWith('live-charts.js=29994')) &&
  !spustenePoReloadu.some(x => x.startsWith('live-ui.js=7181')),
  spustenePoReloadu.join(' '));

console.log('\n  → spouštím živý režim\n');
await js(`document.getElementById('btn-live')?.click()`);
await sleep(7000);
const zivy = await js(`(() => {
  const cv = document.getElementById('c-live-spec');
  if (!cv) return { chyba: 'plátno není v DOM' };
  const panel = document.getElementById('panel-live');
  const info = {
    clientW: cv.clientWidth, clientH: cv.clientHeight, attrW: cv.width, attrH: cv.height,
    panelHidden: panel ? panel.classList.contains('hidden') : null,
    styleW: getComputedStyle(cv).width,
  };
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let opaque = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) opaque++;
  return Object.assign(info, { w: cv.width, h: cv.height, opaquePx: opaque,
           ton: document.getElementById('lv-note').textContent,
           lvl: document.getElementById('lv-lvl').textContent,
           warn: (document.getElementById('live-warn') || {}).textContent,
           engine: (document.getElementById('live-engine') || {}).textContent });
})()`);
console.log('  ', JSON.stringify(zivy));
ok('živý spektrogram KRESLÍ obraz (ne prázdné okno)',
  !zivy.__err && zivy.opaquePx > 1000,
  'nakreslených pixelů: ' + (zivy.opaquePx ?? '?') + ', tón ' + (zivy.ton ?? '?'));

console.log('\n  konzole:', logs.length ? logs.slice(0, 5).join(' | ') : '(prázdná)');
console.log(`\n═══ KONZISTENCE VERZÍ: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══\n`);

server.close();
chrome.kill('SIGKILL');
process.exit(fails ? 1 : 0);
