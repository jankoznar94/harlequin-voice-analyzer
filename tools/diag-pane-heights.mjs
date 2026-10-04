#!/usr/bin/env node
// Diagnostika: rozpadne výšku každého panelu záložky po jednotlivých dílech,
// aby bylo vidět, ODKUD se bere rozdíl (přepnutí záložky nesmí pohnout obsahem
// pod grafy). Měří se v reálné aplikaci včetně okrajů a marginů.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 9349);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + PORT);
const APP_URL = process.env.APP_URL || 'http://localhost:8123/index.html';
const WIDTH = Number(process.env.W || 0);
mkdirSync(PROFILE, { recursive: true });

const SR = 48000;
const notes = [[392, 1.2], [523.25, 1.2], [659.25, 1.2], [783.99, 1.2]];
const gap = Math.round(0.35 * SR);
const total = notes.reduce((a, [, d]) => a + Math.round(d * SR), 0) + gap * (notes.length - 1);
const x = new Float64Array(total);
let o = 0;
for (const [f0, dur] of notes) {
  const n = Math.round(dur * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR; let s = 0;
    for (let h = 1; h < 60; h++) {
      const fh = f0 * h; if (fh > SR / 2 - 200) break;
      const env = Math.exp(-((fh - 2900) ** 2) / (2 * 900 ** 2)) + 0.5 * Math.exp(-((fh - 700) ** 2) / (2 * 400 ** 2));
      s += (1 / h) * env * Math.sin(2 * Math.PI * fh * t);
    }
    const fade = Math.min(1, i / (0.02 * SR)) * Math.min(1, (n - i) / (0.05 * SR));
    x[o + i] = 0.35 * s * fade;
  }
  o += n + gap;
}
const buf = Buffer.alloc(44 + x.length * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + x.length * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(x.length * 2, 40);
for (let i = 0; i < x.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
const wavB64 = buf.toString('base64');

const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch {}
  await sleep(250);
}
if (!ws) { console.error('CDP se nepřipojilo'); process.exit(1); }
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evalJs = async (e, aw = false) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw });
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text) }; return r.result.value; };

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: APP_URL }); await sleep(3000);
if (WIDTH) await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: true });
setInterval(() => { send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }, 400);
await evalJs(`(async () => { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister()));
  const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); return true; })()`, true);
await evalJs(`(() => { const bin = atob(${JSON.stringify(wavB64)}); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const dt = new DataTransfer(); dt.items.add(new File([u8], 't.wav', { type: 'audio/wav' }));
  const inp = document.getElementById('file-input'); inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
for (let i = 0; i < 60; i++) { await sleep(1000);
  const st = await evalJs(`document.querySelectorAll('#t-notes tbody tr').length`); if (st > 0) break; }

console.log(await evalJs(`(() => {
  const log = [];
  log.push('okno: ' + window.innerWidth + ' px');
  const panes = ['spr', 'spec', 'f1'];
  for (const w of panes) {
    document.getElementById('tab-' + w).click();
    const pane = document.getElementById('pane-' + w);
    const wrap = pane.querySelector('.chart-wrap');
    const foot = pane.querySelector('.pane-foot');
    const cs = getComputedStyle(foot);
    log.push(w + ': pane ' + pane.getBoundingClientRect().height.toFixed(1)
      + ' | wrap ' + wrap.getBoundingClientRect().height.toFixed(1)
      + ' | foot ' + foot.getBoundingClientRect().height.toFixed(1)
      + ' (minH ' + cs.minHeight + ', mt ' + cs.marginTop + ', mb ' + cs.marginBottom + ')'
      + ' | children ' + [...foot.children].map(c => c.tagName + ':' + c.getBoundingClientRect().height.toFixed(1)
          + '(mt' + getComputedStyle(c).marginTop + ',mb' + getComputedStyle(c).marginBottom + ')').join(' '));
  }
  return log.join('\\n');
})()`));
chrome.kill('SIGKILL');
process.exit(0);
