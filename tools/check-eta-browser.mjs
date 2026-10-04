#!/usr/bin/env node
/**
 * Odhad zbývajícího času v REÁLNÉM prohlížeči.
 *
 * PROČ: test-eta.mjs ověřuje logiku v Node, ale ne to, jestli se odhad
 * v aplikaci skutečně objeví a jestli se hýbe podle práce. Tady se sleduje
 * text `#prog-eta` po dobu analýzy — na záznamu, kde to trvá dost dlouho
 * na to, aby se odhad vůbec stihl ukázat (v prohlížeči je to podstatně
 * rychlejší než na telefonu, takže se používá dlouhá nahrávka).
 *
 * Použití:  node tools/check-eta-browser.mjs [soubor.wav]
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 9351);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + PORT);
const FILE = process.argv[2] || join(process.env.HOME, '.cache/vaud-test/zpev.wav');
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find((t) => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(250);
}
if (!ws) { console.error('CDP se nepřipojilo'); process.exit(1); }
await new Promise((r) => ws.onopen = r);

let id = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
async function evalJs(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text) };
  return r.result.value;
}

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'http://localhost:8123/index.html' });
await sleep(3000);

/* Analýza je na počítači hotová za 2,7 s, takže odhad se ani nestihne ukázat
 * (ukazuje se až po 3 s). Zpomalení CPU se používá proto, aby to odpovídalo
 * telefonu — tam je analýza i dvacetkrát delší. */
const THROTTLE = Number(process.env.THROTTLE || 1);
if (THROTTLE > 1) { await send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }); }

const pollDialogs = setInterval(() => { send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }, 400);

await evalJs(`(async () => {
  window.__err = [];
  window.addEventListener('error', e => window.__err.push(String(e.message)));
  // service worker drží staré assety — bez odregistrování by se měřil starý kód
  const rs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(rs.map(x => x.unregister()));
  for (const k of await caches.keys()) await caches.delete(k);
  return 'ok';
})()`, true);

const b64 = readFileSync(FILE).toString('base64');
console.log('soubor:', FILE);

await evalJs(`(() => {
  const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const fl = new File([u8], 'zpev.wav', { type: 'audio/wav' });
  window.__t0 = performance.now();
  const dt = new DataTransfer(); dt.items.add(fl);
  const inp = document.getElementById('file-input');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return fl.size;
})()`, true);

const trace = [];
const t0 = Date.now();
while (Date.now() - t0 < 180000) {
  const s = await evalJs(`(() => {
    const rs = document.getElementById('panel-result');
    return {
      el: Math.round(performance.now() - window.__t0),
      text: document.getElementById('prog-text').textContent,
      eta: document.getElementById('prog-eta').textContent,
      bar: document.getElementById('prog-fill').style.width,
      done: !rs.classList.contains('hidden'),
      meta: document.getElementById('r-meta').textContent,
      errs: window.__err,
    };
  })()`);
  trace.push(s);
  if (s?.done || s?.errs?.length) break;
  await sleep(300);
}
clearInterval(pollDialogs);
chrome.kill();

console.log('\n=== PRŮBĚH (co uživatel viděl) ===');
const shown = trace.filter((x) => x.eta);
for (let i = 0; i < trace.length; i += Math.max(1, Math.floor(trace.length / 22))) {
  const x = trace[i];
  console.log(`  ${(x.el / 1000).toFixed(1).padStart(5)} s  ${String(x.bar).padStart(6)}  ${x.text.slice(0, 34).padEnd(34)} ${x.eta}`);
}
const last = trace[trace.length - 1];
console.log('\n=== STAV ===');
console.log(JSON.stringify({ celkem_ms: last.el, hotovo: last.done, meta: last.meta, chyby: last.errs }, null, 1));
console.log(`\nodhad se ukázal: ${shown.length} vzorků, naposledy „${shown.length ? shown[shown.length - 1].eta : '—'}"`);
