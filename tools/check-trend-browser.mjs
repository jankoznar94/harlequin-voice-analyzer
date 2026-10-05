#!/usr/bin/env node
/**
 * Dověření sondy: je na křivce VIDĚT pokles ringu?
 *
 * Předchozí sonda měřila rozdíl proti kresbě bez řady — jenže ta PŘEŠKÁLUJE
 * osu Y (rozsah se rozšíří o křivku), takže se změní celý graf a sonda
 * „měřila" překreslení, ne křivku. Naměřeno: 298 z 300 sloupců změněno,
 * obě poloviny na 23 px → k ničemu.
 *
 * Správně: hledat KONKRÉTNÍ BARVU tahu (zelená #6a9e6a) v JEDNOM vykreslení
 * a porovnat její svislou polohu vlevo a vpravo. Když ring spadne, je čára
 * vpravo NÍŽ (větší y).
 *
 * Použití: node tools/check-trend-browser.mjs
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT || 9381);
const CDP_PORT = Number(process.env.CDP_PORT || 9382);
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
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description || 'chyba' };
  return r.result?.result?.value;
};

await send('Page.enable'); await send('Runtime.enable');
const url = `http://127.0.0.1:${PORT}/index.html`;
await send('Page.navigate', { url }); await sleep(2500);
await evalJs(`(async () => {
  const rs = await navigator.serviceWorker?.getRegistrations?.() || [];
  await Promise.all(rs.map(x => x.unregister()));
  const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k)));
})()`);
await send('Page.navigate', { url }); await sleep(2500);

const out = await evalJs(`(async () => {
  const { analyze } = await import('./src/analysis.js');
  const { drawSpr } = await import('./src/charts.js');
  const SR = 48000, N = 6 * SR;
  const x = new Float64Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const b = t < 3 ? 1 : 0.10;
    const f = 220 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * i / SR));
    ph += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h * 220 < 5200; h++) {
      const fh = h * 220;
      const F = [[700, 1, 110], [1220, 0.5, 130], [2600, b * 0.35, 190]];
      let g = 0; for (const [fc, a, bw] of F) g += a / (1 + ((fh - fc) / bw) ** 2);
      v += Math.max(0.03, g) * Math.sin(h * ph) / Math.sqrt(h);
    }
    x[i] = 0.25 * v;
  }
  const res = analyze(x, SR, { fach: 'tenor' });
  const n = res.notes[0];
  const cv = document.getElementById('c-spr');
  drawSpr(cv, res.notes, res.summary);
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const img = ctx.getImageData(0, 0, W, H).data;
  const dpr = window.devicePixelRatio || 1;

  /* Tah křivky má barvu COL.ok #6a9e6a (ring_ok) — hledá se NEJVYŠŠÍ pixel
   * této barvy v daném sloupci. Barevná pásma mají stejný odstín, ale jinou
   * alfou (0,22) → slabší; práh na kanál to oddělí. */
  const isStroke = (i) => {
    const r = img[i], g = img[i + 1], bl = img[i + 2];
    return Math.abs(r - 0x6a) < 26 && Math.abs(g - 0x9e) < 26 && Math.abs(bl - 0x6a) < 26
      && g > r + 20;                     // zelená převažuje
  };
  const topAt = (frac) => {
    const padL = 46, padR = 12;
    const plotW = (W / dpr) - padL - padR;
    const px = Math.min(W - 1, Math.max(0, Math.round((padL + frac * plotW) * dpr)));
    let best = -1, cnt = 0;
    for (let yy = 0; yy < H; yy++) {
      const i = (yy * W + px) * 4;
      if (isStroke(i)) { cnt++; if (best < 0) best = yy; }
    }
    return { y: best, cnt };
  };
  const cols = [];
  for (let frac = 0.05; frac <= 0.99; frac += 0.05) cols.push([frac, topAt(frac)]);
  const a = topAt(0.20), b = topAt(0.80);
  return { dpr, W, H, body: n.spr_series?.length, note: n.note,
    trend: res.summary.ring_trend_drops, cols, a, b };
})()`);

cleanup();
if (out?.error) { console.log('CHYBA:', out); process.exit(1); }

console.log(`\n=== prohlížeč ${out.W}×${out.H} (dpr ${out.dpr}) · tón ${out.note} · ${out.body} bodů řady ===`);
console.log('\nnejvyšší pixel tahu křivky (zelená #6a9e6a) na daném místě tónu:');
for (const [frac, v] of out.cols) {
  console.log(`  ${(frac * 100).toFixed(0).padStart(3)} %: y=${String(v.y).padStart(4)}  (pixelů ${v.cnt})`);
}
console.log(`\nvlevo (20 % tónu): y=${out.a.y} px, vpravo (80 %): y=${out.b.y} px → pokles ${out.b.y - out.a.y} px`);
console.log(`analýza hlásí: ${JSON.stringify(out.trend)}`);
const ok = out.a.y >= 0 && out.b.y >= 0 && (out.b.y - out.a.y) > 10;
console.log(`\n${ok ? '✓' : '✗'} křivka je na plátně a v pravé polovině je NÍŽ (ring spadl)`);
process.exit(ok ? 0 : 1);
