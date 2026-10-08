#!/usr/bin/env node
/**
 * Náhled grafu ringu — jeden snímek plátna `#c-spr` z reálné analýzy souboru.
 *
 * PROČ: statické testy vidí, že se křivka kreslí, ale ne jak to vypadá. Při
 * změně „všechny tóny křivkou" (1.0.40) je potřeba vidět, že tóny netvoří
 * jednolitou plochu a že křivky mezi sebou mají mezery (tóny se v grafu dají
 * rozlišit). Snímek se ukládá do PNG a cesta se vypíše.
 *
 * Použití: node tools/shot-spr.mjs <soubor.wav> [výstup.png]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { guard } from '../test/lib/chrome-guard.mjs';

const FILE = process.argv[2] || 'rec-test/zpev.wav';
const OUT = process.argv[3] || '/tmp/spr-nahled.png';
const PORT = Number(process.env.PORT || 8137);
const CDP_PORT = Number(process.env.CDP_PORT || 9361);
const CHROME = process.env.CHROME || 'chromium-browser';
const PROFILE = path.join(process.env.HOME, '.cache', 'va-chrome-shot-spr');

if (!existsSync(FILE)) { console.error(`chybí soubor ${FILE}`); process.exit(2); }

/* Statický server nad adresářem aplikace — aplikace jinak nemá odkud brát
 * moduly (file:// moduly v Chromiu neprojdou). */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const p = path.join(process.cwd(), decodeURIComponent(req.url.split('?')[0]));
  try {
    const b = readFileSync(p);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end('ne'); }
});
await new Promise(r => server.listen(PORT, r));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1200,1400', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const stop = guard({ chrome, server, port: CDP_PORT, hardTimeoutMs: 240000 });
let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d.toString(); });

let ws = null, id = 0;
const pending = new Map();
function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
}

(async () => {
  let url = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) { url = page.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(250);
  }
  if (!url) throw new Error('Chromium se nepřihlásil.\n' + chromeErr.slice(-500));

  ws = new WebSocket(url);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://localhost:${PORT}/index.html` });
  await sleep(2500);
  await send('Runtime.evaluate', { expression: `(async () => {
    const rs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(rs.map(x => x.unregister()));
    for (const k of await caches.keys()) await caches.delete(k);
    return 'ok';
  })()`, awaitPromise: true });

  const b64 = readFileSync(FILE).toString('base64');
  await send('Runtime.evaluate', { expression: `(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u8], 'nahled.wav', { type: 'audio/wav' }));
    const inp = document.getElementById('file-input');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'posláno';
  })()`, awaitPromise: true });

  let hotovo = false;
  for (let i = 0; i < 150; i++) {
    await sleep(1000);
    const r = await send('Runtime.evaluate', { expression: `(() => {
      const res = document.getElementById('panel-result');
      return { hotovo: !!res && !res.classList.contains('hidden'),
               prog: (document.getElementById('prog-text')?.textContent || '').trim() };
    })()`, returnByValue: true });
    if (r.result?.value?.hotovo) { hotovo = true; break; }
  }
  if (!hotovo) throw new Error('analýza nedoběhla');

  // přepnout na záložku ringu a nechat dokreslit (layoutCharts jede v rAF)
  await send('Runtime.evaluate', { expression: `(() => {
    document.getElementById('tab-spr')?.click();
    window.dispatchEvent(new Event('resize'));
    return 'ok';
  })()`, returnByValue: true });
  await sleep(1500);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('snímek: ' + OUT);
  stop(0);
})().catch(e => { console.error('CHYBA: ' + e.message); stop(1); });
