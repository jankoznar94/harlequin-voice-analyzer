#!/usr/bin/env node
/* Prožene REÁLNÝ soubor v REÁLNÉM prohlížeči celou cestou aplikace
 * (file-input → decodeAudio → analyze → UI) a přečte, co UI napsalo.
 *
 * Na rozdíl od `check-browser-file.mjs` posílá soubor s PRAVÝM jménem i MIME
 * typem podle přípony — `decodeAudioData` se na typ dívá a nahrávka z aplikace
 * je `audio/webm;codecs=opus`, ne „audio/mpeg".
 *
 * Použití: node tools/check-file-browser.mjs cesta/soubor.webm [soubor2 …]
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const PORT = Number(process.env.PORT || 9361);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + PORT);
const APP_URL = process.env.APP_URL || 'http://localhost:8123/index.html';
const FILES = process.argv.slice(2);
if (!FILES.length) { console.error('dej mi soubory'); process.exit(1); }
mkdirSync(PROFILE, { recursive: true });

const MIME = {
  '.webm': 'audio/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.opus': 'audio/ogg', '.ogg': 'audio/ogg',
};

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
if (!ws) { console.error('CDP se nepřipojilo'); process.exit(1); }
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
await send('Page.navigate', { url: APP_URL });
await sleep(3000);

const dialogs = [];
setInterval(() => send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}), 300);

for (const f of FILES) {
  if (!existsSync(f)) { console.log(`CHYBI: ${f}`); continue; }
  await send('Page.navigate', { url: APP_URL });
  await sleep(2000);
  await evalJs(`(() => { window.__err = []; window.__dialogs = [];
    window.alert = m => { window.__dialogs.push(String(m)); };
    window.addEventListener('error', e => window.__err.push(String(e.message)));
    return 'ok'; })()`);

  const b64 = readFileSync(f).toString('base64');
  const name = basename(f);
  const mime = MIME[extname(f).toLowerCase()] || 'application/octet-stream';
  const ins = await evalJs(`(async () => {
    const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const fl = new File([u8], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} });
    window.__t0 = performance.now();
    const inp = document.getElementById('file-input');
    const dt = new DataTransfer(); dt.items.add(fl); inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return fl.size;
  })()`, true);

  let st = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    st = await evalJs(`(() => {
      const pr = document.getElementById('panel-progress');
      const rs = document.getElementById('panel-result');
      return { prog: document.getElementById('prog-text').textContent,
        progressHidden: pr.classList.contains('hidden'),
        resultShown: !rs.classList.contains('hidden'),
        meta: document.getElementById('r-meta').textContent,
        unusable: document.getElementById('r-unusable').innerText.slice(0, 700),
        kpi: (document.getElementById('r-body').innerText || '').slice(0, 700),
        errs: window.__err, dialogs: window.__dialogs,
        elapsed: Math.round(performance.now() - window.__t0) };
    })()`);
    if (st?.resultShown || st?.errs?.length || st?.dialogs?.length) break;
    if (st?.progressHidden && !st?.resultShown) break;
    await sleep(700);
  }
  console.log('═'.repeat(74));
  console.log(`${name}  (${mime}, ${(ins / 1024).toFixed(0)} kB)`);
  console.log('  meta   :', st?.meta);
  if (st?.unusable) console.log('  HLASKA :', st.unusable.replace(/\s+/g, ' '));
  if (st?.kpi) console.log('  KPI    :', st.kpi.replace(/\s+/g, ' ').slice(0, 500));
  if (st?.errs?.length) console.log('  CHYBY  :', st.errs);
  if (st?.dialogs?.length) console.log('  ALERTY :', st.dialogs);
}
chrome.kill();
process.exit(0);
