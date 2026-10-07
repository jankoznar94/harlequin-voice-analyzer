#!/usr/bin/env node
/**
 * Totéž co diag-live-spec-real.mjs, ale v EMULACI TELEFONU (úzká šířka,
 * vysoká hustota displeje). Právě tam se živý spektrogram rozbíjí, i když
 * v širokém okně funguje.
 *
 * Použití: node tools/diag-live-spec-mobil.mjs [wav]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 8162;
const CDP_PORT = 9362;
const PROFILE = path.join(process.env.HOME, '.cache/va-spec-diag-mobil');
const WAV = process.argv[2] || path.join(ROOT, 'rec-test/zpev.wav');
const W = Number(process.env.MOB_W || 390);
const H = Number(process.env.MOB_H || 844);
const DPR = Number(process.env.MOB_DPR || 3);

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const server = spawn('node', ['serve.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(1200);

const chrome = spawn('chromium-browser', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${WAV}`,
  '--autoplay-policy=no-user-gesture-required',
  'about:blank',
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
if (!ws) { console.error('CDP se nepřipojilo'); server.kill('SIGKILL'); chrome.kill(); process.exit(1); }
await new Promise(r => ws.onopen = r);

let id = 0; const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function js(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text) };
  return r.result.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: DPR, mobile: true,
});
await send('Browser.grantPermissions', { origin: `http://localhost:${PORT}`, permissions: ['audioCapture'] }).catch(() => {});

const APP_URL = process.env.APP_URL || `http://localhost:${PORT}/index.html`;
await send('Page.navigate', { url: APP_URL });
await sleep(2500);

console.log(`\n═══ emulace telefonu ${W}×${H}, dpr ${DPR} — ${APP_URL} ═══`);
console.log('před spuštěním:', JSON.stringify(await js(`(() => {
  const cv = document.getElementById('c-live-spec');
  return { clientW: cv.clientWidth, clientH: cv.clientHeight, w: cv.width, h: cv.height, dpr: window.devicePixelRatio };
})()`)));

await js(`document.getElementById('btn-live').click()`);
await sleep(1200);
console.log('po kliknutí:', JSON.stringify(await js(`(() => {
  const cv = document.getElementById('c-live-spec');
  return { panel: !document.getElementById('panel-live').classList.contains('hidden'),
           engine: document.getElementById('live-engine').textContent,
           warn: document.getElementById('live-warn').textContent,
           clientW: cv.clientWidth, clientH: cv.clientHeight, w: cv.width, h: cv.height };
})()`)));

const sample = async () => js(`(() => {
  const cv = document.getElementById('c-live-spec');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let opaque = 0, bright = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 200) { opaque++; sum += (d[i] + d[i + 1] + d[i + 2]) / 3; }
    if (d[i] > 120) bright++;
  }
  return { w: cv.width, h: cv.height, opaquePx: opaque, brightPx: bright,
           avg: opaque ? +(sum / opaque).toFixed(1) : 0,
           tón: document.getElementById('lv-note').textContent,
           lvl: document.getElementById('lv-lvl').textContent,
           čas: document.getElementById('lv-time').textContent };
})()`);

for (let s = 1; s <= Number(process.env.SECONDS || 6); s++) {
  await sleep(1000);
  console.log(`  ${s}s:`, JSON.stringify(await sample()));
}

console.log('\n═══ konzole ═══');
console.log(logs.length ? logs.slice(-25).join('\n') : '(prázdná)');

server.kill('SIGKILL');
chrome.kill('SIGKILL');
process.exit(0);
