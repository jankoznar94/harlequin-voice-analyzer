#!/usr/bin/env node
// Ověří v reálném prohlížeči, že dlaždice „Délka vokálního traktu" (#k-vtl)
// skutečně vykreslí číslo a že se v nahrávce naměří — ne jen že je v HTML.
// Vloží syntetický soubor s tóny v nízké poloze (tam metrika funguje).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 9370);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + PORT);
const APP_URL = process.env.APP_URL || 'http://localhost:8123/index.html';
const W = Number(process.env.W || 390);
mkdirSync(PROFILE, { recursive: true });

/* ── vyrobím WAV s tóny v NIŽŠÍ poloze (110–200 Hz), kde metrika funguje ── */
const SR = 24000;
function vyrobWav() {
  const f0s = [110, 131, 147, 175, 196];
  const sek = 1.2;
  const vsechny = new Float64Array(Math.round(f0s.length * sek * SR));
  const F = [500, 1500, 2500];
  const gain = (f) => {
    const r = (fc, bw, a) => a / (1 + ((f - fc) / bw) ** 2);
    return r(F[0], 120, 1.0) + r(F[1], 180, 0.45) + r(F[2], 220, 0.30)
         + r(3000, 250, 0.22) + r(3500, 300, 0.10);
  };
  f0s.forEach((f0, k) => {
    const a = Math.round(k * sek * SR), b = Math.round((k + 1) * sek * SR);
    let fi = 0;
    for (let i = a; i < b; i++) {
      fi += 2 * Math.PI * f0 / SR;
      let s = 0;
      for (let h = 1; h * f0 < 6000; h++) s += (gain(h * f0) / h) * Math.sin(h * fi);
      const fade = Math.min(1, (i - a) / 300) * Math.min(1, (b - i) / 300);
      vsechny[i] = 0.3 * s * fade;
    }
  });
  const n = vsechny.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(vsechny[i] * 32767))), 44 + i * 2);
  const p = join(PROFILE, 'vtl-test.wav');
  writeFileSync(p, buf);
  return p;
}
const WAV = vyrobWav();

const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  `--window-size=${W},900`, '--autoplay-policy=no-user-gesture-required', 'about:blank'],
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

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: APP_URL });
await sleep(3000);

/* ⚠️ POŘADÍ JE KRITICKÉ: aplikace si sama registruje service worker a ten drží
 * STARÉ assety (třeba index.html bez nové dlaždice). Musí se uklidit a stránka
 * se musí NAČÍST ZNOVU — jinak test měří starý kód a hlásí „prvek chybí",
 * což vypadá jako chyba aplikace, ale je to chyba testu. */
await ev(`(async () => {
  try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(x => x.unregister())); } catch (e) {}
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (e) {}
  return 'sw uklizen'; })()`, true);
await send('Page.navigate', { url: APP_URL });
await sleep(2500);

await ev(`(() => { window.__err = []; window.__dialogs = [];
  window.alert = m => window.__dialogs.push(String(m));
  window.addEventListener('error', e => window.__err.push(String(e.message))); return 'ok'; })()`);

import { readFileSync } from 'node:fs';
const b64 = readFileSync(WAV).toString('base64');
const ins = await ev(`(async () => {
  const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([u8], 'vtl.wav', { type: 'audio/wav' }));
  const inp = document.getElementById('file-input');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return u8.length; })()`, true);
console.log('vložen soubor, bajtů:', ins);

let stav = null;
for (let i = 0; i < 40; i++) {
  stav = await ev(`(() => {
    const g = (i) => { const n = document.getElementById(i); return n ? n.textContent : 'CHYBI'; };
    return { prog: g('prog-text'),
      resultShown: !document.getElementById('panel-result').classList.contains('hidden'),
      kvtl: g('k-vtl'), kvtlS: g('k-vtl-s'), kvtlD: (document.getElementById('k-vtl-d') || {}).textContent,
      meta: g('r-meta'), errs: window.__err, dialogs: window.__dialogs,
      verdikt: g('r-verdict') }; })()`);
  if (stav?.resultShown || stav?.dialogs?.length || stav?.errs?.length) break;
  await sleep(1000);
}
console.log('\n=== DLAŽDICE #k-vtl PO ANALÝZE ===');
console.log(JSON.stringify({ kvtl: stav.kvtl, kvtlS: stav.kvtlS, meta: stav.meta,
  errs: stav.errs, dialogs: stav.dialogs }, null, 1));
console.log('\n=== vysvětlení (k-vtl-d) ===\n' + (stav.kvtlD || '').slice(0, 700));
console.log('\n=== verdikt (zmínka o traktu?) ===\n' + (stav.verdikt || '').slice(0, 700));

chrome.kill(); process.exit(0);
