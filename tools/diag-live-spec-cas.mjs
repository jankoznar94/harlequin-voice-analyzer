#!/usr/bin/env node
/**
 * Vyfotí živý spektrogram v několika časech po startu — aby se dalo
 * POSUDIT, jestli obraz dorůstá zleva a jestli je nevyplněná část prázdná.
 *
 * Číselná sonda na to nestačí: buffer se předplní barvou pozadí, takže je
 * „nakreslené" celé plátno a rozdíl data/pozadí je jen v odstínu. Oko (nebo
 * model nad snímkem) to pozná spolehlivěji.
 *
 * Použití: node tools/diag-live-spec-cas.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.join(import.meta.dirname, '..');
const PORT = 8167, CDP_PORT = 9367;
const PROFILE = path.join(process.env.HOME, '.cache/va-spec-cas');
const WAV = process.env.WAV || path.join(ROOT, 'rec-test/zpev.wav');
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}/index.html`;
const OUT = process.env.OUT || process.env.HOME + '/.cache/live-spec-cas';
const CASY = (process.env.CASY || '1,3,6').split(',').map(Number);
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

let id = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? { __err: String(r.exceptionDetails.exception?.description) } : r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: true });
await send('Browser.grantPermissions', { origin: new globalThis.URL(APP_URL).origin, permissions: ['audioCapture'] }).catch(() => {});
await send('Page.navigate', { url: APP_URL });
await sleep(3000);

console.log(`\n═══ Snímky živého spektrogramu v čase — ${APP_URL} ═══\n`);
await js(`document.getElementById('btn-live').click()`);

let cas = 0;
for (const c of CASY) {
  await sleep(Math.max(0, c - cas) * 1000);
  cas = c;
  const dataUrl = await js(`document.getElementById('c-live-spec').toDataURL('image/png')`);
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image')) {
    const f = `${OUT}-${c}s.png`;
    fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`  ${c}s → ${f}`);
  } else {
    console.log(`  ${c}s → plátno se nepodařilo vyfotit`, dataUrl);
  }
}

console.log('  konzole: ok');
server.kill('SIGKILL');
chrome.kill('SIGKILL');
process.exit(0);
