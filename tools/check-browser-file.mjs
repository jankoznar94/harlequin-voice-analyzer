#!/usr/bin/env node
// Ověří v reálném prohlížeči: (a) plná cesta soubor → analýza, (b) chování při
// omezené paměti (emulace telefonu), (c) dekódování na nižším vzorkovacím kmitočtu.
//
// Použití:
//   APP_URL=… FILE_URL=… node tools/check-browser-file.mjs
//   DECODE_RATE=16000 …      (vnutí AudioContext s nižším SR)
//   LOW_END=1 …              (--enable-low-end-device-mode, chová se jako telefon)
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 9333);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + PORT);
const FILE = process.argv[2] || join(process.env.HOME, 'vocal-lab-app/testdata.mp3');
const APP_URL = process.env.APP_URL || 'http://localhost:8123/index.html';
const FILE_URL = process.env.FILE_URL || '';
const DECODE_RATE = process.env.DECODE_RATE || '';
mkdirSync(PROFILE, { recursive: true });

const flags = ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--autoplay-policy=no-user-gesture-required'];
if (process.env.LOW_END) flags.push('--enable-low-end-device-mode', '--disable-dev-shm-usage');
const chrome = spawn('chromium-browser', [...flags, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find(t => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(250);
}
if (!ws) { console.error('CDP se nepřipojilo'); process.exit(1); }
await new Promise(r => ws.onopen = r);

let id = 0; const pending = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
async function evalJs(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text) };
  return r.result.value;
}

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: APP_URL });
await sleep(3000);

const pollDialogs = setInterval(() => { send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }, 400);

await evalJs(`(() => { window.__err = []; window.__dialogs = [];
  window.alert = m => { window.__dialogs.push(String(m)); };
  window.addEventListener('error', e => window.__err.push(String(e.message)));
  ${DECODE_RATE ? `const Orig = window.AudioContext || window.webkitAudioContext;
  window.AudioContext = class extends Orig { constructor(){ super({ sampleRate: ${DECODE_RATE} }); } };
  window.webkitAudioContext = window.AudioContext;` : ''}
  return 'ok'; })()`);

const b64 = FILE_URL ? null : readFileSync(FILE).toString('base64');
console.log('soubor:', FILE_URL || FILE, '· decodeRate:', DECODE_RATE || 'výchozí', '· lowEnd:', !!process.env.LOW_END);

const ins = await evalJs(`(async () => {
  const inp = document.getElementById('file-input');
  let fl;
  if (${!!FILE_URL}) {
    const r = await fetch(${JSON.stringify(FILE_URL)});
    fl = new File([await r.blob()], 'nahravka.mp3', { type: 'audio/mpeg' });
  } else {
    const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    fl = new File([u8], 'nahravka.mp3', { type: 'audio/mpeg' });
  }
  window.__file = fl; window.__t0 = performance.now();
  const dt = new DataTransfer(); dt.items.add(fl);
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return fl.size;
})()`, true);
console.log('vloženo do stránky, bajtů:', ins?.__err ? ins : ins);

let state = null;
const t0 = Date.now();
while (Date.now() - t0 < Number(process.env.WAIT_S || 200) * 1000) {
  state = await evalJs(`(() => {
    const pr = document.getElementById('panel-progress');
    const rs = document.getElementById('panel-result');
    return {
      prog: document.getElementById('prog-text').textContent,
      progressHidden: pr.classList.contains('hidden'),
      resultShown: !rs.classList.contains('hidden'),
      meta: document.getElementById('r-meta').textContent,
      body: rs.innerText.slice(0, 900),
      errs: window.__err, dialogs: window.__dialogs,
      elapsed: Math.round(performance.now() - window.__t0),
    };
  })()`);
  if (state?.resultShown || state?.errs?.length || state?.dialogs?.length) break;
  if (state?.progressHidden && !state?.resultShown) break;
  await sleep(1000);
}
clearInterval(pollDialogs);
console.log('\n=== STAV (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s) ===');
console.log(JSON.stringify({ ...state, body: undefined }, null, 1));
if (state?.resultShown) console.log('\n=== VÝSLEDEK ===\n' + state.body);
chrome.kill();
process.exit(0);
