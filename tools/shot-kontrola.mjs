#!/usr/bin/env node
/**
 * Snímek kontrolní stránky `kontrola-prah-osa.html` + text z <pre id="out">.
 * Statický server nad adresářem aplikace, pak headless Chromium přes CDP.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { guard } from '../test/lib/chrome-guard.mjs';

const PAGE = process.argv[2] || 'kontrola-prah-osa.html';
const OUT = process.argv[3] || '/tmp/kontrola-prah-osa.png';
const PORT = Number(process.env.PORT || 8141);
const CDP_PORT = Number(process.env.CDP_PORT || 9371);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
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
const chrome = spawn(process.env.CHROME || 'chromium-browser',
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
   `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${process.env.HOME}/.cache/va-chrome-kontrola`,
   '--window-size=820,760', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const stop = guard({ chrome, server, port: CDP_PORT, hardTimeoutMs: 120000 });
let err = ''; chrome.stderr.on('data', d => { err += d.toString(); });

let ws = null, id = 0; const pending = new Map();
const send = (method, params = {}) => {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => pending.set(mid, { res, rej }));
};

(async () => {
  let url = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) { url = page.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(250);
  }
  if (!url) throw new Error('Chromium se nepřihlásil.\n' + err.slice(-400));
  ws = new WebSocket(url);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://localhost:${PORT}/${PAGE}` });
  await sleep(2500);
  const t = await send('Runtime.evaluate', { expression: `document.getElementById('out')?.textContent || '(nic)'`, returnByValue: true });
  console.log(t.result?.value || '');
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('snímek: ' + OUT);
  stop(0);
})().catch(e => { console.error('CHYBA: ' + e.message); stop(1); });
