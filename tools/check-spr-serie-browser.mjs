#!/usr/bin/env node
/**
 * Ověření v REÁLNÉM prohlížeči: kreslí se u dlouhého tónu KŘIVKA?
 *
 * Mock canvasu (test/test-spr-serie.mjs) ověří, že kód volá stroke/fill.
 * Tohle ověřuje, že je to na plátně VIDĚT — tedy že z křivky skutečně něco
 * zůstane v pixelech. Skill to vyžaduje: „ověření na konci: prohlížeč,
 * ne jen Node“.
 *
 * Postup: spustí serve.mjs, otevře stránku, vloží do ní syntetický 5s tón
 * s ŘÍZENÝM poklesem ringu v polovině, spustí analyze() + drawSpr() a sonduje
 * pixely: kolik sloupců plátna je „obarvených“ v levé a pravé polovině tónu.
 * Sloupec by dal obarvený jen úzký pruh; křivka musí obarvit obě poloviny.
 *
 * Použití: node tools/check-spr-serie-browser.mjs
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT || 9377);
const CDP_PORT = Number(process.env.CDP_PORT || 9378);
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

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { err: r.result.exceptionDetails.exception?.description || 'chyba' };
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
// Uklidit service worker a cache PŘED načtením (jinak test měří starý kód).
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(2500);
await evalJs(`(async () => {
  const rs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(rs.map(x => x.unregister()));
  const ks = await caches.keys();
  await Promise.all(ks.map(k => caches.delete(k)));
})()`);
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
await sleep(2500);

const out = await evalJs(`(async () => {
  const { analyze } = await import('./src/analysis.js');
  const { drawSpr } = await import('./src/charts.js');
  const SR = 48000, N = 5 * SR;
  const x = new Float64Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const b = t < 2.5 ? 1 : 0.10;   // ring v polovině spadne
    const f = 220 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * i / SR));
    ph += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h * 220 < 5200; h++) {
      const fh = h * 220;
      const F = [[700, 1.0, 110], [1220, 0.5, 130], [2600, b * 0.35, 190]];
      let g = 0; for (const [fc, a, bw] of F) g += a / (1 + ((fh - fc) / bw) ** 2);
      v += Math.max(0.03, g) * Math.sin(h * ph) / Math.sqrt(h);
    }
    x[i] = 0.25 * v;
  }
  const res = analyze(x, SR, { fach: 'tenor' });
  const n = res.notes[0];
  const ser = n?.spr_series;
  if (!ser) return { error: 'tón nemá časovou řadu', notes: res.notes.length, dropped: res.dropped };

  const cv = document.getElementById('c-spr');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const snap = () => Array.from(ctx.getImageData(0, 0, W, H).data);

  /* Sonda NESMÍ počítat „vše, co není pozadí“ — přes celou šířku jdou
   * barevná pásma a mřížka, takže by vyšlo stejné číslo všude a nic by
   * neměřila (přesně to se stalo napoprvé). Měří se ROZDÍL proti kresbě
   * bez časové řady: co křivka přidá, a kde. */
  drawSpr(cv, res.notes.map(o => ({ ...o, spr_series: undefined })), res.summary);
  const without = snap();
  drawSpr(cv, res.notes, res.summary);
  const withSer = snap();

  const cols = [];
  for (let xx = 0; xx < W; xx++) {
    let c = 0;
    for (let yy = 0; yy < H; yy++) {
      const i = (yy * W + xx) * 4;
      const d = Math.abs(withSer[i] - without[i]) + Math.abs(withSer[i + 1] - without[i + 1]) + Math.abs(withSer[i + 2] - without[i + 2]);
      if (d > 30) c++;
    }
    cols.push(c);
  }
  const dpr = window.devicePixelRatio || 1;
  const padL = 46, padR = 12;
  const plotW = (W / dpr) - padL - padR;
  const picks = [];
  for (let frac = 0.05; frac <= 0.99; frac += 0.05) {
    const px = Math.min(W - 1, Math.round((padL + frac * plotW) * dpr));
    picks.push([frac, cols[px] || 0]);
  }
  /* Střed křivky v levé a pravé polovině — musí být NÍŽ (ring spadl).
   * Hledá se nejvyšší (nejmenší y) změněný pixel v daném sloupci. */
  const topAt = (frac) => {
    const px = Math.min(W - 1, Math.round((padL + frac * plotW) * dpr));
    for (let yy = 0; yy < H; yy++) {
      const i = (yy * W + px) * 4;
      const d = Math.abs(withSer[i] - without[i]) + Math.abs(withSer[i + 1] - without[i + 1]) + Math.abs(withSer[i + 2] - without[i + 2]);
      if (d > 30) return yy;
    }
    return -1;
  };
  return {
    dpr, W, H, padL, padR,
    note: { t0: n.t_start, t1: n.t_end, dur: n.dur, spr: n.spr, spr_novy: n.spr_novy },
    body: ser.length,
    picks,
    topLeft: topAt(0.20), topRight: topAt(0.80),
    changed: cols.filter(c => c > 0).length,
  };
})()`);

cleanup();
if (out?.error) { console.log('CHYBA:', out); process.exit(1); }

console.log(`\n=== prohlížeč: ${out.W}×${out.H} px (dpr ${out.dpr}) ===`);
console.log(`tón ${out.note.t0.toFixed(2)}–${out.note.t1.toFixed(2)} s · ${out.body} bodů řady`);
console.log('\npixely, které křivka PŘIDALA (proti kresbě bez řady) na daném místě tónu:');
for (const [frac, c] of out.picks) console.log(`  ${(frac * 100).toFixed(0).padStart(3)} % tónu: ${String(c).padStart(4)} px`);
const ok = out.changed > 0.5 * (out.W);
console.log(`\n${ok ? '✓' : '✗'} křivka je vidět po CELÉ délce tónu — ${out.changed} z ${out.W} sloupců plátna se změnilo`);
console.log(`  (kdyby šlo o jeden sloupec, změnil by se jen ~18px pruh uprostřed)`);
console.log(`\nstřed křivky: vlevo (20 % tónu) y=${out.topLeft} px · vpravo (80 %) y=${out.topRight} px`);
const drop = out.topRight - out.topLeft;
console.log(`${drop > 10 ? '✓' : '✗'} ring v pravé polovině SPADL — křivka je o ${drop} px níž (víc px = níž v grafu)`);
process.exit(ok && drop > 10 ? 0 : 1);
