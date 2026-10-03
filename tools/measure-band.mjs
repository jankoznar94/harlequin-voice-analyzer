#!/usr/bin/env node
// Změří přímo v prohlížeči: dekódování MP3 → analyze() → pásmo/špička/počet tónů.
// Slouží k porovnání různých vzorkovacích kmitočtů AudioContextu (telefon vs. počítač).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 9350);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + PORT);
const FILE_URL = process.env.FILE_URL || 'http://localhost:8123/testdata.mp3';
const RATE = process.env.DECODE_RATE || '';
mkdirSync(PROFILE, { recursive: true });

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
async function evalJs(expr, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text) };
  return r.result.value;
}

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'http://localhost:8123/index.html' });
await sleep(2500);

const out = await evalJs(`(async () => {
  const r = await fetch(${JSON.stringify(FILE_URL)});
  const ab = await r.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx(${RATE ? `{ sampleRate: ${RATE} }` : ''});
  let audio;
  if (${!!process.env.FORCE_OFFLINE}) {
    // OfflineAudioContext není vázaný na hardware → dekóduje vždy na 48 kHz
    const off = new OfflineAudioContext(1, 1, 48000);
    audio = await off.decodeAudioData(ab.slice(0));
  } else {
    audio = await ctx.decodeAudioData(ab.slice(0));
    await ctx.close().catch(() => {});
  }
  const sr = audio.sampleRate, nch = audio.numberOfChannels;
  const mono = new Float64Array(audio.length);
  for (let c = 0; c < nch; c++) { const d = audio.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / nch; }
  await ctx.close();
  const { analyze } = await import('./src/analysis.js?v=' + Date.now());
  const t0 = performance.now();
  const res = analyze(mono, sr, {});
  const ms = performance.now() - t0;
  return {
    audioSampleRate: sr, channels: nch, duration: +(audio.length / sr).toFixed(1),
    pcmMB: +(audio.length * nch * 4 / 1e6).toFixed(1),
    analyzeMs: Math.round(ms),
    band_limit: res.band?.limit, band_valid: res.band?.valid, band_reason: res.band?.reason,
    peak_dbfs: res.peak_dbfs,
    n_notes: res.n_notes, notes_total: res.summary?.n_notes_total,
    spr_unusable: res.summary?.spr_unusable, reason: res.summary?.reason,
    ring: res.summary?.ring_consistency_pct, spr_median: res.summary?.spr_median,
    fhe: res.summary?.fhe_median,
  };
})()`);
console.log('DECODE_RATE=' + (RATE || 'výchozí'));
console.log(JSON.stringify(out, null, 1));
chrome.kill();
process.exit(0);
