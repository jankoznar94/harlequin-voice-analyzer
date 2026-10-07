#!/usr/bin/env node
/**
 * Měří, jestli živý spektrogram DORŮSTÁ (data jen vlevo) nebo jestli se
 * nevyplněná část maluje přes celou šířku.
 *
 * ⚠️ Dvě pasti, na které sonda napoprvé naletěla:
 *  1. **Mřížka a čárkované linky pásma formantu vedou přes CELOU šířku**,
 *     takže „sloupec má nenulový pixel" platí i pro prázdné pozadí.
 *     Řádky v pásu linek se proto přeskakují.
 *  2. **Prahování jasu nestačí** — ticho ve spektru leží blízko pozadí.
 *     Rozhoduje přesná ROVNOST s barvou pozadí: prázdný sloupec je celý
 *     přesně pozadí.
 *
 * Měří se navíc „šířka rozmazaného sloupce vpravo", což je přímý znak
 * původní vady: nejnovější sloupec se roztahoval až k pravému okraji
 * (`plotWpx`), takže jeden sloupec zabíral ZBYTEK grafu.
 *
 * Použití: node tools/diag-live-spec-sloupce.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 8168, CDP_PORT = 9368;
const PROFILE = path.join(process.env.HOME, '.cache/va-spec-sloupce');
const WAV = process.env.WAV || path.join(ROOT, 'rec-test/zpev.wav');
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}/index.html`;
const W = Number(process.env.MOB_W || 390), H = Number(process.env.MOB_H || 844);
const DPR = Number(process.env.MOB_DPR || 3);

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
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
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
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true });
await send('Browser.grantPermissions', { origin: new globalThis.URL(APP_URL).origin, permissions: ['audioCapture'] }).catch(() => {});
await send('Page.navigate', { url: APP_URL });
await sleep(3000);

const mereni = () => js(`(() => {
  const cv = document.getElementById('c-live-spec');
  const dpr = window.devicePixelRatio || 1;
  const x0 = Math.round(42 * dpr), x1 = cv.width - Math.round(12 * dpr);
  const y0 = Math.round(12 * dpr), y1 = cv.height - Math.round(26 * dpr);
  const plotH = y1 - y0;
  /* Řádky s čárkovanými linkami pásma formantu (2,5 a 3,2 kHz) se přeskakují —
   * vedou přes celou šířku a jinak každý sloupec „má data". */
  const skip = new Set();
  for (const hz of [2500, 3200]) {
    const yc = Math.round(y0 + plotH - (hz / 6000) * plotH);
    for (let d = -4; d <= 4; d++) skip.add(yc + d);
  }
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;

  /* Barva pozadí = nejčastější barva MIMO linky. Prázdný sloupec je celý
   * přesně takový, takže rovnost je jednoznačný znak. */
  const hist = new Map();
  for (let y = y0; y < y1; y++) {
    if (skip.has(y)) continue;
    for (let x = x0; x < x1; x += 4) {
      const i = (y * cv.width + x) * 4;
      const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      hist.set(k, (hist.get(k) || 0) + 1);
    }
  }
  let pozadi = 0, max = -1;
  for (const [k, n] of hist) if (n > max) { max = n; pozadi = k; }
  const pR = (pozadi >> 16) & 255, pG = (pozadi >> 8) & 255, pB = pozadi & 255;

  let sDaty = 0, konciNa = -1;
  const sloupecPozadi = [];
  for (let x = x0; x < x1; x++) {
    let vsechnyPozadi = true;
    for (let y = y0; y < y1; y++) {
      if (skip.has(y)) continue;
      const i = (y * cv.width + x) * 4;
      if (d[i] !== pR || d[i + 1] !== pG || d[i + 2] !== pB) { vsechnyPozadi = false; break; }
    }
    sloupecPozadi.push(vsechnyPozadi ? 1 : 0);
    if (!vsechnyPozadi) { sDaty++; konciNa = x - x0; }
  }
  const celkem = x1 - x0;

  /* Vpravo od posledního sloupce s daty musí být JEDNOLITÉ pozadí — to je
   * přesně to, co uživatel chce („ať je tam prostě prázdno"). Původní vada
   * (roztahující se sloupec) se projevila tak, že data sahala na 100 % šířky
   * už v první sekundě. */
  let variaciVPravo = 0;
  for (let x = konciNa + 1; x < celkem; x++) if (!sloupecPozadi[x]) variaciVPravo++;

  return { celkem, sDaty, prazdne: celkem - sDaty,
           podil: +(sDaty / celkem).toFixed(3), konciNa,
           podilKonci: konciNa >= 0 ? +(konciNa / celkem).toFixed(3) : 0,
           variaciVPravo, pozadiRGB: pR + ',' + pG + ',' + pB };
})()`);

console.log(`\n═══ Dorůstá obraz zleva? — ${APP_URL} ═══\n`);
console.log('  (linky pásma formantu se přeskakují — vedou přes celou šířku)\n');
await js(`document.getElementById('btn-live').click()`);

const rada = [];
for (let s = 1; s <= 8; s++) {
  await sleep(1000);
  const m = await mereni();
  rada.push(m);
  console.log(`  ${s}s: podíl ${String((m.podil * 100).toFixed(0)).padStart(3)} %` +
    `, končí na ${String((m.podilKonci * 100).toFixed(0)).padStart(3)} % šířky` +
    `, vpravo od dat variace ${m.variaciVPravo}`);
}

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

console.log('');
const prvni = rada[0], posledni = rada[rada.length - 1];
ok('data DORŮSTAJÍ zleva (podíl stoupá)',
  posledni.podil > prvni.podil + 0.15,
  `${(prvni.podil * 100).toFixed(0)} % → ${(posledni.podil * 100).toFixed(0)} %`);
ok('v první sekundě není plná šířka',
  prvni.podil < 0.5, `${(prvni.podil * 100).toFixed(0)} %`);
ok('po 8 s není plná šířka (okno je ~10 s)',
  posledni.podil < 0.95, `${(posledni.podil * 100).toFixed(0)} %`);
ok('nevyplněná část je prázdné pozadí',
  posledni.prazdne > 0, `${posledni.prazdne} sloupců pozadí`);
ok('vpravo od dat je JEDNOLITÉ prázdné pozadí (žádné variace)',
  posledni.variaciVPravo === 0,
  `${posledni.variaciVPravo} sloupců s obsahem vpravo od dat`);

console.log(`\n═══ DORŮSTÁNÍ: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══\n`);

server.kill('SIGKILL');
chrome.kill('SIGKILL');
process.exit(fails ? 1 : 0);
