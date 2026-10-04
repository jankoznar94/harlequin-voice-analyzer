#!/usr/bin/env node
// Ověřuje cestu „Nahrávat" (#btn-record) v reálném prohlížeči — celou:
//   klik → getUserMedia (stub s tónem 330 Hz) → nahrávací lišta → Ukončit → analýza.
//
// PROČ TAKTO: class `hidden` nic nedokazuje. Prvek může být odklikaný, ale
// neviditelný, protože ho schovává RODIČ. Proto se viditelnost měří třikrát:
//   1) classList + offsetParent + checkVisibility()
//   2) getBoundingClientRect (nenulová plocha)
//   3) PIXELY ze snímku obrazovky (Page.captureScreenshot) — tuhle cestu
//      nemůže oklamat `display: none`
// Tím se pozná „tlačítko existuje" od „tlačítko je vidět".
//
// Použití:
//   node tools/check-nahravat-browser.mjs
//   W=390 node tools/check-nahravat-browser.mjs       (šířka telefonu, výchozí 390)
//   MIKROFON=ne node tools/check-nahravat-browser.mjs (bez mikrofonu → má přijít alert)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 9360);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + PORT);
const APP_URL = process.env.APP_URL || 'http://localhost:8123/index.html';
const W = Number(process.env.W || 390);
const H = Number(process.env.H || 844);
const MIKROFON = process.env.MIKROFON !== 'ne';
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  `--window-size=${W},${H}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 40; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = l.find(t => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(250);
}
if (!ws) { console.error('CDP se nepřipojilo'); process.exit(1); }
await new Promise(r => ws.onopen = r);

let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr, aw = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw });
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text) };
  return r.result.value;
}

const STAV = `(() => {
  const prvek = (i) => { const n = document.getElementById(i); if (!n) return { id: i, chybi: true };
    const r = n.getBoundingClientRect();
    return { id: i, hidden: n.classList.contains('hidden'),
      rodic: n.parentElement ? (n.parentElement.id || n.parentElement.tagName) : '-',
      rodicHidden: n.parentElement ? n.parentElement.classList.contains('hidden') : null,
      offsetParent: n.offsetParent ? 'je' : 'NENI',
      checkVisibility: typeof n.checkVisibility === 'function' ? n.checkVisibility() : 'n/a',
      rect: { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) } }; };
  return {
    panelInput: prvek('panel-input'), recBar: prvek('rec-bar'), btnStop: prvek('btn-stop'),
    btnRecord: prvek('btn-record'), recTime: (document.getElementById('rec-time') || {}).textContent,
    uryvek: document.body.innerText.includes('Ukončit nahrávání'),
    vyskaStranky: document.body.scrollHeight,
  };
})()`;

// světlé pixely ve svislých pásech 20 px (CSS) — pozadí je tmavé (#1a1715)
async function pixely(tag) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = await ev(`(async () => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + ${JSON.stringify(shot.data)}; });
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const dpr = img.width / window.innerWidth;
    const krok = Math.round(20 * dpr), pasy = [];
    for (let y = 0; y < cv.height; y += krok) {
      let s = 0;
      for (let k = y; k < Math.min(y + krok, cv.height); k++)
        for (let x = 0; x < cv.width; x++) { const i = (k * cv.width + x) * 4;
          if (d[i] > 90 || d[i+1] > 90 || d[i+2] > 90) s++; }
      pasy.push(Math.round(y / dpr) + 'px: ' + s);
    }
    return pasy;
  })()`, true);
  console.log('--- vykreslené pixely: ' + tag + ' (světlé pixely po 20px pásech) ---');
  console.log(out.join('\n'));
}

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: APP_URL });
await sleep(3000);

await ev(`(() => { window.__err = []; window.__dialogs = []; window.__kroky = [];
  window.alert = m => window.__dialogs.push(String(m));
  window.addEventListener('error', e => window.__err.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => window.__err.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
  return 'ok'; })()`);

if (MIKROFON) {
  await ev(`(() => {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator(); osc.frequency.value = 330;
    const g = ac.createGain(); g.gain.value = 0.25;
    osc.connect(g); g.connect(dest); osc.start();
    navigator.mediaDevices.getUserMedia = async function (c) { window.__kroky.push('getUserMedia: ' + JSON.stringify(c)); return dest.stream; };
    return 'stub'; })()`);
} else {
  await ev(`(() => { try { delete navigator.mediaDevices.getUserMedia; } catch (e) {}
    Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true }); return 'bez mikrofonu'; })()`);
}

console.log('### před klikem na „Nahrávat" ###');
console.log(JSON.stringify(await ev(STAV), null, 1));

await ev(`document.getElementById('btn-record').click(), 'ok'`);
await sleep(2500);
console.log('\n### 2,5 s po kliku na „Nahrávat" ###');
console.log(JSON.stringify(await ev(STAV), null, 1));
await pixely('po kliku na Nahrávat');

if (MIKROFON) {
  await ev(`document.getElementById('btn-stop').click(), 'ok'`);
  let hotovo = null;
  for (let i = 0; i < 25; i++) {
    hotovo = await ev(`({ prog: document.getElementById('prog-text').textContent,
      progress: !document.getElementById('panel-progress').classList.contains('hidden'),
      result: !document.getElementById('panel-result').classList.contains('hidden'),
      meta: document.getElementById('r-meta').textContent,
      dialogs: window.__dialogs.slice(), errs: window.__err.slice() })`);
    if (hotovo.result || hotovo.dialogs.length || hotovo.errs.length) break;
    await sleep(1000);
  }
  console.log('\n### po „Ukončit nahrávání" ###');
  console.log(JSON.stringify(hotovo, null, 1));
}

console.log('\n### kroky a chyby ###');
console.log(JSON.stringify(await ev(`({ kroky: window.__kroky, dialogs: window.__dialogs, errs: window.__err })`), null, 1));

chrome.kill(); process.exit(0);
