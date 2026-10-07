#!/usr/bin/env node
/**
 * Ověřuje, že živý spektrogram roste SPRÁVNĚ: nevyplněná část je prázdné
 * pozadí a obraz dorůstá zleva doprava, jak přicházejí sloupce.
 *
 * Souvisí s opravou blikání (`tools/diag-live-spec-flicker.mjs`): tam šlo
 * o to, aby se plátno nevymazávalo každý rámec. Tady jde o to, že se při té
 * opravě nesmí rozbít POSTUPNÉ vykreslování.
 *
 * ⚠️ Měří se JAS, ne průhlednost. Buffer se předplní barvou pozadí
 * (`SPEC_BG`, naměřeno ~19 z 255), takže je nakreslené CELÉ plátno —
 * nevyplněná část má jen nejtmavší odstín stupnice. Sonda podle alfy proto
 * hlásila „100 % nakresleno" už v první sekundě, což vypadalo jako chyba
 * růstu, ale byl to špatný znak.
 *
 * Použití: node tools/diag-live-spec-rost.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 8166, CDP_PORT = 9366;
const PROFILE = path.join(process.env.HOME, '.cache/va-spec-rost');
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

/**
 * Profil obrazu podle jasu. Vrací, kolik sloupců je nad prahem pozadí
 * a kde končí nejvzdálenější sloupec s daty (od levého okraje).
 */
const profil = () => js(`(() => {
  const cv = document.getElementById('c-live-spec');
  const dpr = window.devicePixelRatio || 1;
  const padL = Math.round(42 * dpr), padR = Math.round(12 * dpr);
  const padT = Math.round(12 * dpr), padB = Math.round(26 * dpr);
  const x0 = padL, x1 = cv.width - padR;
  const y0 = padT, y1 = cv.height - padB;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const jas = new Float64Array(cv.width);
  for (let x = x0; x < x1; x++) {
    let s = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      const i = (y * cv.width + x) * 4;
      s += (d[i] + d[i + 1] + d[i + 2]) / 3; n++;
    }
    jas[x] = n ? s / n : 0;
  }
  const pozadi = jas[x0 + 2];
  const prah = pozadi + 3;
  let nad = 0, posledni = -1;
  for (let x = x0; x < x1; x++) if (jas[x] > prah) { nad++; posledni = x; }
  const celkem = x1 - x0;
  return { w: cv.width, celkem, pozadi: +pozadi.toFixed(1), prah: +prah.toFixed(1),
           nad, podil: +(nad / celkem).toFixed(3),
           konciNa: posledni >= 0 ? posledni - x0 : -1 };
})()`);

console.log(`\n═══ Růst obrazu — ${APP_URL} ═══\n`);
await js(`document.getElementById('btn-live').click()`);

const rada = [];
for (let s = 1; s <= 8; s++) {
  await sleep(1000);
  const p = await profil();
  rada.push(p);
  console.log(`  ${s}s: dat ${String(p.nad).padStart(4)} z ${p.celkem} sloupců ` +
    `(${(p.podil * 100).toFixed(0)} %), končí na ${p.konciNa}, pozadí ${p.pozadi}`);
}

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

console.log('');
const prvni = rada[0], posledni = rada[rada.length - 1];
ok('obraz roste (podíl sloupců s daty stoupá)',
  posledni.podil > prvni.podil,
  `${(prvni.podil * 100).toFixed(0)} % → ${(posledni.podil * 100).toFixed(0)} %`);
ok('v první sekundě je vyplněna jen malá část okna (dorůstá zleva)',
  prvni.podil > 0.02 && prvni.podil < 0.35,
  `${(prvni.podil * 100).toFixed(0)} % (okno je ~10 s)`);
ok('po 8 s není vyplněno víc než 85 % (okno je ~10 s)',
  posledni.podil < 0.85, `${(posledni.podil * 100).toFixed(0)} %`);
ok('nevyplněná část zůstává prázdná (neroste do ní šum)',
  posledni.podil < 1,
  `nenakresleno ${posledni.celkem - posledni.nad} sloupců`);
ok('nejvzdálenější data odpovídají uplynulému času',
  Math.abs((posledni.konciNa / posledni.celkem) - posledni.podil) < 0.1,
  `končí na ${posledni.konciNa} z ${posledni.celkem} (${(100 * posledni.konciNa / posledni.celkem).toFixed(0)} %)`);

console.log('  konzole:', logs.length ? logs.slice(0, 3).join(' | ') : '(prázdná)');
console.log(`\n═══ RŮST: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══\n`);

server.kill('SIGKILL');
chrome.kill('SIGKILL');
process.exit(fails ? 1 : 0);
