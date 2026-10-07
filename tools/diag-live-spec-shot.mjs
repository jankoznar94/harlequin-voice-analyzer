#!/usr/bin/env node
/**
 * Vyfotí živý spektrogram v reálném prohlížeči (i z produkce) a uloží PNG.
 * K pixelovým statistikám přidává to, co uvidí oko: skutečný snímek plátna
 * i celé stránky. Slouží k porovnání živého obrazu s reportem z nahrávky.
 *
 * Použití: APP_URL=… node tools/diag-live-spec-shot.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 8163, CDP_PORT = 9363;
const PROFILE = path.join(process.env.HOME, '.cache/va-spec-shot');
const WAV = process.env.WAV || path.join(ROOT, 'rec-test/zpev.wav');
const W = Number(process.env.MOB_W || 390), H = Number(process.env.MOB_H || 844);
const DPR = Number(process.env.MOB_DPR || 3);
const OUT = process.env.OUT || '/tmp/live-spec';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}/index.html`;
const WAIT = Number(process.env.WAIT || 8);

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
const server = spawn('node', ['serve.mjs', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(1200);

const chrome = spawn('chromium-browser', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${WAV}`,
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
if (!ws) { console.error('CDP se nepřipojilo'); process.exit(1); }
await new Promise(r => ws.onopen = r);

let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text) } : r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true });
await send('Browser.grantPermissions', { origin: new URL(APP_URL).origin, permissions: ['audioCapture'] }).catch(() => {});
await send('Page.navigate', { url: APP_URL });
await sleep(2500);
await js(`document.getElementById('btn-live').click()`);
await sleep(WAIT * 1000);

// plátno živého spektrogramu jako PNG (dataURL)
const dataUrl = await js(`document.getElementById('c-live-spec').toDataURL('image/png')`);
if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image')) {
  fs.writeFileSync(`${OUT}-canvas.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`plátno uloženo: ${OUT}-canvas.png`);
} else console.log('plátno se nepodařilo vyfotit:', dataUrl);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
fs.writeFileSync(`${OUT}-page.png`, Buffer.from(shot.data, 'base64'));
console.log(`stránka uložena: ${OUT}-page.png`);

// pro srovnání: jak vypadá spektrogram z nahrávky (report) — stejná stupnice
console.log('stav:', JSON.stringify(await js(`(() => {
  const cv = document.getElementById('c-live-spec');
  const d = cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
  let opaque=0,sum=0,bright=0;
  for (let i=0;i<d.length;i+=4){ if(d[i+3]>200){opaque++;sum+=(d[i]+d[i+1]+d[i+2])/3;} if(d[i]>120)bright++; }
  return { w: cv.width, h: cv.height, opaque, bright, avg: opaque?+(sum/opaque).toFixed(1):0,
           ton: document.getElementById('lv-note').textContent, lvl: document.getElementById('lv-lvl').textContent };
})()`)));
console.log('konzole:', logs.length ? logs.join('\n') : '(prázdná)');

server.kill('SIGKILL'); chrome.kill('SIGKILL');
process.exit(0);
