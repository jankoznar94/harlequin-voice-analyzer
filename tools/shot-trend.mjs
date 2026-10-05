#!/usr/bin/env node
/**
 * Vykreslí PNG náhled grafu ringu s křivkami — z REÁLNÉ nahrávky.
 * Slouží k tomu, aby se Jan mohl na výsledek podívat, aniž by musel něco nasazovat.
 *
 * Použití: node tools/shot-trend.mjs soubor.wav vystup.png [od_sekundy] [do_sekundy]
 */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const FILE = resolve(process.argv[2]);
const OUT = resolve(process.argv[3] || '/home/martin_fabian/trend.png');
const T0 = Number(process.argv[4] || 0);
const T1 = Number(process.argv[5] || 0);
const PORT = Number(process.env.PORT || 9391);
const CDP_PORT = Number(process.env.CDP_PORT || 9392);
const PROFILE = join(process.env.HOME, '.cache/va-cdp-' + CDP_PORT);
mkdirSync(PROFILE, { recursive: true });

const serve = spawn('node', ['serve.mjs', String(PORT)], { cwd: join(process.env.HOME, 'vocal-lab-app'), stdio: 'ignore' });
const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { serve.kill(); } catch {} try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const p = list.find(t => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(250);
}
if (!ws) { console.error('CDP se nepřipojilo'); cleanup(); process.exit(1); }
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description || 'chyba' };
  return r.result?.result?.value;
};

await send('Page.enable'); await send('Runtime.enable');
const url = `http://127.0.0.1:${PORT}/index.html`;
await send('Page.navigate', { url }); await sleep(2000);
await evalJs(`(async () => { const rs = await navigator.serviceWorker?.getRegistrations?.() || []; await Promise.all(rs.map(x=>x.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k))); })()`);
await send('Page.navigate', { url }); await sleep(2000);

const b64 = (await import('node:fs')).readFileSync(FILE).toString('base64');
const out = await evalJs(`(async () => {
  const { analyze } = await import('./src/analysis.js');
  const { drawSpr } = await import('./src/charts.js');
  const bin = atob(${JSON.stringify(b64)});
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  // WAV 16 bit mono
  const dv = new DataView(u8.buffer);
  const sr = dv.getUint32(24, true);
  let off = 12, dataOff = 0, dataLen = 0;
  while (off + 8 <= u8.length) {
    const id = String.fromCharCode(u8[off], u8[off+1], u8[off+2], u8[off+3]);
    const sz = dv.getUint32(off + 4, true);
    if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz & 1);
  }
  const n = Math.floor(dataLen / 2);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = dv.getInt16(dataOff + i * 2, true) / 32768;
  const t0 = ${T0}, t1 = ${T1};
  const sel = (t0 || t1) ? x.subarray(Math.round(t0 * sr), t1 ? Math.round(t1 * sr) : n) : x;
  const res = analyze(sel, sr, { fach: 'tenor' });
  const cv = document.getElementById('c-spr');
  // Náhled: rozšířit plátno, ať jsou tóny čitelné
  const W = 1180, H = 300;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const g = drawSpr(cv, res.notes, res.summary, null, { width: W });
  const png = cv.toDataURL('image/png');
  return { png: png.split(',')[1], notes: res.notes.length, ser: res.notes.filter(n=>n.spr_series?.length).length,
    drops: res.summary.ring_trend_drops, ok: res.summary.notes_with_ring, total: res.summary.n_notes };
})()`, true);

cleanup();
if (out?.error) { console.log('CHYBA:', out); process.exit(1); }
writeFileSync(OUT, Buffer.from(out.png, 'base64'));
console.log(`náhled: ${OUT}`);
console.log(`tónů ${out.notes} · s křivkou ${out.ser} · ring ${out.ok}/${out.total}`);
console.log(`poklesů >= 3 dB: ${out.drops.length}`);
for (const d of out.drops.slice(0, 8)) console.log(`  ${d.note} v ${d.t.toFixed(1)} s — pokles ${d.drop_db.toFixed(1)} dB`);
