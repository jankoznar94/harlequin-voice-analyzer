#!/usr/bin/env node
/**
 * Měří POBLIKÁVÁNÍ živého spektrogramu — počítá, kolikrát se za sekundu
 * SAHÁ NA `canvas.width`.
 *
 * PROČ TO TAKHLE: nastavení `canvas.width` podle specifikace VYMAŽE celý
 * bitmap plátna, i když je hodnota stejná. Když se tedy rozměr nastavuje
 * každý rámec (50× za sekundu), plocha, která ještě nemá data, bliká.
 * Oko to vidí jako „nepříjemné poblikávání prázdné části grafu“.
 *
 * Měření je přímé: na plátno se nasadí počítadlo setteru, takže se počítá
 * skutečný počet přiřazení — ne odhad z kódu.
 *
 * Použití: node tools/diag-live-spec-flicker.mjs
 *          APP_URL=… node tools/diag-live-spec-flicker.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 8165, CDP_PORT = 9365;
const PROFILE = path.join(process.env.HOME, '.cache/va-spec-flicker');
const WAV = process.env.WAV || path.join(ROOT, 'rec-test/zpev.wav');
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}/index.html`;
const MERENO_S = Number(process.env.MERENO_S || 4);
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
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method === 'Runtime.exceptionThrown') logs.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0] } : r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true });
await send('Browser.grantPermissions', { origin: new globalThis.URL(APP_URL).origin, permissions: ['audioCapture'] }).catch(() => {});
await send('Page.navigate', { url: APP_URL });
await sleep(3000);

console.log(`\n═══ Poblíkávání živého spektrogramu — ${APP_URL} ═══\n`);

/* Počítadlo se nasadí na VŠECHNA živá plátna, aby se dalo srovnat: ostatní
 * grafy (ladění, SPR) jsou zaplevelené stejným kódem, ale chovají se jinak. */
await js(`(() => {
  window.__sets = {};
  const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  for (const cvId of ['c-live-spec', 'c-live-tune', 'c-live-spr', 'c-live-level']) {
    const cv = document.getElementById(cvId);
    if (!cv) continue;
    window.__sets[cvId] = 0;
    Object.defineProperty(cv, 'width', {
      get() { return d.get.call(this); },
      set(v) { window.__sets[cvId]++; d.set.call(this, v); },
      configurable: true,
    });
  }
  return Object.keys(window.__sets);
})()`);
console.log('počítadla nasazena na:', JSON.stringify(await js(`Object.keys(window.__sets)`)));

await js(`document.getElementById('btn-live').click()`);
await sleep(1500);
await js(`(() => { for (const k in window.__sets) window.__sets[k] = 0; return 1; })()`);
await sleep(MERENO_S * 1000);

const sets = await js(`window.__sets`);
const frames = await js(`(document.getElementById('lv-time') || {}).textContent`);
console.log(`  za ${MERENO_S} s živého režimu (časovač appky ${frames}):`);
for (const [k, v] of Object.entries(sets || {})) {
  const perS = (v / MERENO_S).toFixed(0);
  console.log(`    ${k.padEnd(14)} ${String(v).padStart(5)}× = ${perS}/s ${v > MERENO_S * 10 ? '  ← VYMAZÁVÁ PLÁTNO KAŽDÝ RÁMEC' : ''}`);
}

const specSets = (sets || {})['c-live-spec'] || 0;
console.log('');
if (specSets > MERENO_S * 10) {
  console.log(`  ✗ spektrogram si sahá na rozměr plátna ${(specSets / MERENO_S).toFixed(0)}× za sekundu`);
  console.log('    → každé přiřazení VYMAŽE bitmap, takže nevyplněná část bliká');
} else {
  console.log(`  ✓ spektrogram mění rozměr plátna jen ${specSets}× za ${MERENO_S} s (ne při každém rámci)`);
}

console.log('  konzole:', logs.length ? logs.slice(0, 3).join(' | ') : '(prázdná)');
server.kill('SIGKILL');
chrome.kill('SIGKILL');
process.exit(specSets > MERENO_S * 10 ? 1 : 0);
