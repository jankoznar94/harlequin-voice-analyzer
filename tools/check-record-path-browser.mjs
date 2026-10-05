#!/usr/bin/env node
/* CELÁ CESTA NAHRÁVKY v reálném prohlížeči: mikrofon → MediaRecorder → blob
 * → (stejná cesta jako „Načíst soubor") → analyze() → co napíše UI.
 *
 * Mikrofon se mockuje na PROTOTYPĚ (v Chromiu se přepsání instance neprojeví,
 * viz zkušenost z dřívějška). Zdroj zvuku je AudioBufferSourceNode s reálným
 * zpěvem — NE oscilátor: oscilátor má jedinou harmonickou, takže LPC i pásmo
 * vycházejí jinak a test by měřil něco jiného než nahrávka hlasu.
 *
 * MIME typy se zkoušejí ve stejném pořadí jako v aplikaci (`pickMime`).
 *
 * Použití: node tools/check-record-path-browser.mjs cesta/zpev.wav [sekund]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 9362);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + PORT);
const SRC = process.argv[2] || 'rec-test/zpev.wav';
const SECS = Number(process.argv[3] || 20);
if (!existsSync(SRC)) { console.error('chybí', SRC); process.exit(1); }
mkdirSync(PROFILE, { recursive: true });

const appDir = join(process.env.HOME, 'vocal-lab-app');
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

// 1) co prohlížeč podporuje za MIME typy (stejné pořadí jako aplikace)
const mimes = await evalJs(`(() => {
  const want = ['audio/webm;codecs=pcm','audio/wav','audio/webm;codecs=opus','audio/webm'];
  return want.map(m => [m, !!(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m))]);
})()`);
console.log('podpora MIME typů (v pořadí aplikace):');
for (const [m, ok] of mimes) console.log(`  ${ok ? 'ANO' : 'ne '} ${m}`);

// 2) nahrát přes MediaRecorder z bufferu s reálným zpěvem
const b64 = (await import('node:fs')).readFileSync(SRC).toString('base64');
const rec = await evalJs(`(async () => {
  const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const audio = await ctx.decodeAudioData(u8.buffer.slice(0));
  const secs = Math.min(${SECS}, audio.duration);
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource(); src.buffer = audio; src.connect(dest);
  // mock mikrofonu na PROTOTYPĚ
  Object.getPrototypeOf(navigator.mediaDevices).getUserMedia = async () => dest.stream;
  src.start(0, 0, secs);

  const want = ['audio/webm;codecs=pcm','audio/wav','audio/webm;codecs=opus','audio/webm'];
  const mime = want.find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise(r => rec.onstop = r);
  rec.start();
  await new Promise(r => setTimeout(r, (secs + 0.6) * 1000));
  rec.stop();
  await done;
  const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
  const ab = await blob.arrayBuffer();
  return { mime: rec.mimeType, bytes: blob.size, sampleRateInFile: (() => {
      // co by uhodl sniffSampleRate — jen z hlavičky, hrubý test kontejneru
      const b = new Uint8Array(ab); const tag = o => String.fromCharCode(b[o],b[o+1],b[o+2],b[o+3]);
      return { first4: tag(0), ftypAt4: tag(4) };
    })(), b64: (() => { const u8 = new Uint8Array(ab); let s = '';
      for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
      return btoa(s); })() };
})()`, true);
if (rec?.__err) { console.log('nahrávání selhalo:', rec.__err); }
else {
  console.log(`\nnahráno: mime=${rec.mime} · ${(rec.bytes / 1024).toFixed(0)} kB · první 4 bajty=${JSON.stringify(rec.sampleRateInFile)}`);

  // 3) tentýž blob prohnat cestou aplikace (file-input → analýza → UI)
  const res = await evalJs(`(async () => {
    const bin = atob(${JSON.stringify(rec.b64)}); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const fl = new File([u8], 'z-aplikace.webm', { type: ${JSON.stringify('audio/webm')} });
    window.__t0 = performance.now();
    const inp = document.getElementById('file-input');
    const dt = new DataTransfer(); dt.items.add(fl); inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`, true);
  let st = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    st = await evalJs(`(() => {
      const rs = document.getElementById('panel-result');
      return { resultShown: !rs.classList.contains('hidden'),
        meta: document.getElementById('r-meta').textContent,
        unusable: document.getElementById('r-unusable').innerText.slice(0, 700),
        body: (document.getElementById('r-body').innerText || '').slice(0, 400) };
    })()`);
    if (st?.resultShown) break;
    await sleep(700);
  }
  console.log('\n— výsledek z UI —');
  console.log('meta:', st?.meta);
  if (st?.unusable?.trim()) console.log('HLAŠKA:', st.unusable.replace(/\s+/g, ' '));
  else console.log('KPI:', (st?.body || '').replace(/\s+/g, ' ').slice(0, 300));
}
chrome.kill();
process.exit(0);
