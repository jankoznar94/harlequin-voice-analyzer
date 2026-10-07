#!/usr/bin/env node
/**
 * Proskenuje různé velikosti displeje a hustoty a u každé změří, jestli se
 * živý spektrogram opravdu vykreslil. Hledá konfiguraci, ve které zůstane
 * obraz prázdný (např. když je kreslicí plocha užší než počet sloupců).
 *
 * Použití: APP_URL=… node tools/diag-live-spec-sweep.mjs
 *          bez APP_URL zkouší produkci na GitHub Pages
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 8164, CDP_PORT = 9364;
const PROFILE = path.join(process.env.HOME, '.cache/va-spec-sweep');
const WAV = process.env.WAV || path.join(ROOT, 'rec-test/zpev.wav');
const APP_URL = process.env.APP_URL || 'https://jankoznar94.github.io/harlequin-voice-analyzer/index.html';
const WAIT = Number(process.env.WAIT || 7);

const CONFIGS = [
  [320, 568, 2, 'iPhone SE 1'],
  [360, 640, 2, 'malý Android'],
  [360, 740, 3, 'Android dpr3'],
  [375, 667, 2, 'iPhone 8'],
  [390, 844, 3, 'iPhone 14'],
  [393, 851, 2.75, 'Pixel 7'],
  [412, 915, 2.625, 'Pixel 6'],
  [428, 926, 3, 'iPhone Pro Max'],
  [600, 900, 2, 'tablet úzký'],
  [820, 1180, 2, 'iPad'],
  [1280, 800, 1, 'notebook'],
  [1600, 900, 1.25, 'notebook Windows 125 %'],
  [1000, 700, 1, 'okno 1000 px'],
  [700, 700, 1, 'okno 700 px'],
  [560, 700, 1, 'okno 560 px'],
];

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const chrome = spawn('chromium-browser', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${WAV}`,
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const p = list.find(t => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch { /* ještě neběží */ }
  await sleep(250);
}
if (!ws) { console.error('CDP se nepřipojilo'); process.exit(1); }
await new Promise(r => ws.onopen = r);

let id = 0; const pending = new Map(); let logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method === 'Runtime.exceptionThrown') logs.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0] } : r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Browser.grantPermissions', { origin: new URL(APP_URL).origin, permissions: ['audioCapture'] }).catch(() => {});

const MEASURE = `(() => {
  const cv = document.getElementById('c-live-spec');
  if (!cv) return { chyba: 'plátno není v DOM' };
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let opaque = 0, bright = 0, sum = 0, emptyCols = 0;
  const cols = new Uint8Array(cv.width);
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      if (d[i + 3] > 200) { opaque++; sum += (d[i] + d[i + 1] + d[i + 2]) / 3; cols[x] = 1; }
      if (d[i] > 120) bright++;
    }
  }
  for (let x = 0; x < cv.width; x++) if (!cols[x]) emptyCols++;
  return { clientW: cv.clientWidth, clientH: cv.clientHeight, w: cv.width, h: cv.height,
           dpr: window.devicePixelRatio, opaquePx: opaque, brightPx: bright,
           avg: opaque ? +(sum / opaque).toFixed(1) : 0, emptyCols, obraz: cols.filter(v => v).length,
           verze: (document.querySelector('footer')?.textContent || '').match(/1\\.0\\.\\d+/) || null,
           ton: document.getElementById('lv-note').textContent,
           lvl: document.getElementById('lv-lvl').textContent };
})()`;

console.log(`\n═══ živý spektrogram napříč displeji — ${APP_URL} ═══\n`);
const rows = [];
for (const [w, h, dpr, label] of CONFIGS) {
  logs = [];
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: dpr > 1 });
  await send('Page.navigate', { url: APP_URL + (APP_URL.includes('?') ? '&' : '?') + 't=' + Date.now() });
  await sleep(3000);
  await js(`document.getElementById('btn-live')?.click()`);
  await sleep(WAIT * 1000);
  const m = await js(MEASURE);
  const stav = m.__err ? 'CHYBA ' + m.__err
    : (m.opaquePx > 0 && m.brightPx > 500 ? 'OK' : 'PRÁZDNÝ');
  rows.push({ label, w, h, dpr, ...m, stav });
  console.log(`${label.padEnd(22)} ${String(w).padStart(4)}×${String(h).padEnd(4)} dpr ${String(dpr).padEnd(5)} ` +
    `${stav.padEnd(9)} avg ${String(m.avg).padStart(5)} jasné ${String(m.brightPx).padStart(6)} ` +
    `kanál ${m.clientW}px→${m.w}px  prázdných sloupců ${m.emptyCols ?? '?'}  tón ${m.ton ?? '-'}`);
  if (logs.length) console.log('    konzole: ' + logs.slice(0, 3).join(' | '));
}
fs.writeFileSync('/tmp/live-spec-sweep.json', JSON.stringify(rows, null, 2));
console.log('\nuloženo: /tmp/live-spec-sweep.json');
chrome.kill('SIGKILL');
process.exit(0);
