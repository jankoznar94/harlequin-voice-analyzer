#!/usr/bin/env node
/* Ověří v REÁLNÉM prohlížeči, že se vyřazené úseky dostanou až do stažených
 * souborů — tedy že je uživatel po exportu opravdu vidí.
 *
 * Test v mocku to ověřit NEMŮŽE: `download()` sahá na <a>.click() a objektové
 * URL, takže v mocku se jen pozná, že soubor vznikl, ne co je v něm.
 *
 * Postup: vložit soubor s tónem MIMO obor → analýza → kliknout na „Stáhnout JSON"
 * a „Stáhnout report" a přečíst obsah (v prohlížeči se podstrčí `download`,
 * aby text zůstal ve stránce).
 *
 * Použití: node tools/check-vyrazene-browser.mjs [soubor.wav]
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const PORT = Number(process.env.PORT || 9365);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + PORT);
const SRC = process.argv[2] || 'rec-test/zpev.wav';
if (!existsSync(SRC)) { console.error('chybí', SRC); process.exit(1); }
mkdirSync(PROFILE, { recursive: true });

const MIME = { '.wav': 'audio/wav', '.webm': 'audio/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };

const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });

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
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
async function evalJs(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text) };
  return r.result.value;
}

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'http://localhost:8123/index.html' });
await sleep(2500);
setInterval(() => send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}), 300);

// zachytit stahování: přepsat download() cestu přes URL.createObjectURL → čtení blobu
await evalJs(`(() => {
  window.__dl = [];
  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const u = origCreate(blob);
    blob.text().then(t => window.__dl.push({ url: u, text: t }));
    return u;
  };
  return 'ok';
})()`);

const b64 = readFileSync(SRC).toString('base64');
const mime = MIME[extname(SRC).toLowerCase()] || 'audio/wav';
await evalJs(`(async () => {
  const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const fl = new File([u8], 'test.wav', { type: ${JSON.stringify(mime)} });
  const inp = document.getElementById('file-input');
  const dt = new DataTransfer(); dt.items.add(fl); inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`, true);

let st = null;
for (let i = 0; i < 90; i++) {
  st = await evalJs(`(() => ({ shown: !document.getElementById('panel-result').classList.contains('hidden'),
    meta: document.getElementById('r-meta').textContent }))()`);
  if (st?.shown) break;
  await sleep(1000);
}
console.log('analýza:', st?.meta);

const files = await evalJs(`(async () => {
  window.__dl = [];
  document.getElementById('btn-json').onclick();
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('btn-md').onclick();
  await new Promise(r => setTimeout(r, 300));
  return window.__dl.map(d => ({ len: d.text.length, text: d.text }));
})()`, true);
if (files?.__err) { console.log('chyba:', files.__err); process.exit(1); }

for (const f of (files || [])) {
  const isJson = f.text.trimStart().startsWith('{');
  console.log(`\n── ${isJson ? 'JSON' : 'markdown'} (${f.len} znaků) ──`);
  if (isJson) {
    const o = JSON.parse(f.text);
    console.log('  klíče výsledku:', Object.keys(o).join(', '));
    console.log('  dropped:', Array.isArray(o.dropped) ? `${o.dropped.length} záznamů` : 'CHYBI!');
    if (Array.isArray(o.dropped) && o.dropped.length) {
      console.log('  první:', JSON.stringify(o.dropped[0]));
      console.log('  důvody:', [...new Set(o.dropped.map(d => d.why.replace(/\(.*\)/, '').trim()))].join(' | '));
    }
    console.log('  n_dropped:', o.n_dropped);
  } else {
    const i = f.text.indexOf('## Vyřazené tóny');
    console.log(i >= 0 ? f.text.slice(i, i + 420) : '  sekce „## Vyřazené tóny" CHYBI!');
  }
}
chrome.kill();
process.exit(0);
