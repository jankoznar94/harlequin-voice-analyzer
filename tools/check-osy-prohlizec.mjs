#!/usr/bin/env node
/**
 * Změří v REÁLNÉM prohlížeči časovou osu grafu ringu proti přehrávači.
 *
 * Postup: soubor se vloží do aplikace, počká se na výsledek, pak se v TÉŽE
 * stránce soubor znovu dekóduje a spustí se `analyze()` + `sprGeom()` z reálného
 * `charts.js` — tím získáme přesně to, co kresba používá (`t1`, `t_end` posledního
 * tónu, délku nahrávky), a k tomu se změří, kde v plátně doopravdy leží popisky
 * času (skupiny světlých pixelů).
 *
 * Odpovídá na „ukazatel času na grafu doběhl dřív než ukazatel u přehrávače".
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.PORT || 9361);
const CDP_PORT = Number(process.env.CDP_PORT || 9362);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + CDP_PORT);
mkdirSync(PROFILE, { recursive: true });
const FILE = resolve(process.env.FILE || join(process.env.HOME, 'vocal-lab-app/rec-test/zpev.wav'));
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}/index.html`;

const serve = spawn('node', ['serve.mjs', String(PORT)], { cwd: join(process.env.HOME, 'vocal-lab-app'), stdio: 'ignore' });
const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { serve.kill(); } catch {} try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const p = list.find(t => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(250);
}
if (!ws) { console.error('CDP se nepřipojilo'); process.exit(1); }
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) };
  return r.result?.result?.value;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: APP_URL }); await sleep(2500);
await evalJs(`(async () => { const rs = await navigator.serviceWorker?.getRegistrations?.() || []; await Promise.all(rs.map(x=>x.unregister())); const ks = await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k))); return 1; })()`, true);
await send('Page.navigate', { url: APP_URL }); await sleep(2500);
await evalJs(`(() => { window.__err=[]; window.addEventListener('error', e=>window.__err.push(String(e.message))); return 1; })()`);

const b64 = readFileSync(FILE).toString('base64');
console.log('soubor:', FILE);
await evalJs(`window.__b64 = ${JSON.stringify(b64)}; 1`);
await evalJs(`(async () => {
  const bin = atob(window.__b64); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const f = new File([u8], 'x.wav', { type: 'audio/wav' });
  const dt = new DataTransfer(); dt.items.add(f);
  const inp = document.getElementById('file-input');
  inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
  return f.size;
})()`, true);

let st = null;
for (let i = 0; i < 120; i++) {
  st = await evalJs(`(() => ({ shown: !document.getElementById('panel-result').classList.contains('hidden'), meta: document.getElementById('r-meta').textContent, time: document.getElementById('play-time').textContent, errs: window.__err }))()`);
  if (st?.shown || st?.errs?.length) break;
  await sleep(1000);
}
console.log('meta:', st?.meta, '| přehrávač:', st?.time, '| chyby:', st?.errs);

const out = await evalJs(`(async () => {
  const { analyze } = await import('./src/analysis.js');
  const { sprGeom, SPR_H } = await import('./src/charts.js');
  const bin = atob(window.__b64); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const off = new OfflineAudioContext(1, 1, 48000);
  const buf = await off.decodeAudioData(u8.buffer.slice(0));
  const samples = buf.getChannelData(0);
  const dur = samples.length / buf.sampleRate;
  const res = analyze(samples, buf.sampleRate, { fach: 'tenor', progress: () => {} });
  /* POZOR — niceTicks a fmtClock v charts.js exportované NEJSOU (jsou to vnitřní
   * pomocníci kresby), takže se v sondě opisují. Opis je tady bezpečný jen
   * proto, že sonda neporovnává kresbu s výpočtem, ale rovnou MĚŘÍ pixely
   * popisků v plátně; opis slouží jen k tomu, aby se vědělo, které hodnoty
   * hledat. Kdyby se opis rozešel s kresbou, pozná se to podle toho, že
   * naměřené skupiny pixelů nesedí na tick_expected_x. */
  const niceTicks = (min, max, count = 5) => {
    if (!(max > min)) return [min];
    const raw = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
    return out;
  };
  const fmtClock = (t) => {
    const s = Math.round(t);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  const cv = document.getElementById('c-spr');
  /* Délku PŘEDÁVÁME — přesně jako to dělá aplikace (sprDrawOpts posílá
   * duration). Bez ní sonda měří starou geometrii, kde osa končila posledním
   * tónem, a vyšlo by, že se nic nezměnilo. */
  const g = sprGeom(cv.clientWidth, cv.clientHeight, res.notes, res.summary, 0, dur);

  /* Naměřené popisky v plátně: pás s popisky času je u y = h - padB + 14. */
  const dpr = window.devicePixelRatio || 1;
  const ctx = cv.getContext('2d');
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const yBase = (cv.clientHeight - 34 + 14) * dpr;
  const y0 = Math.max(0, Math.round(yBase - 11 * dpr)), y1 = Math.min(cv.height, Math.round(yBase + 2 * dpr));
  const cols = [];
  for (let x = 0; x < cv.width; x++) {
    let lit = 0;
    for (let y = y0; y < y1; y++) {
      const i = (y * cv.width + x) * 4;
      if ((img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3 > 80) lit++;
    }
    if (lit) cols.push(x);
  }
  const groups = []; let cur = null;
  for (const x of cols) { if (cur && x - cur[1] <= 8) cur[1] = x; else { if (cur) groups.push(cur); cur = [x, x]; } }
  if (cur) groups.push(cur);

  const ticks = niceTicks(0, g.t1, 6).filter(v => v > 0);
  return {
    audio_duration_s: +dur.toFixed(2),
    analyze_duration_s: +res.duration_s.toFixed(2),
    spr_t1_s: +g.t1.toFixed(2),
    last_note_end_s: +Math.max(...res.notes.map(n => n.t_end)).toFixed(2),
    n_notes: res.notes.length,
    canvas_css_w: cv.clientWidth,
    canvas_css_h: cv.clientHeight,
    canvas_style_w: cv.style.width,
    ticks_s: ticks.map(v => +v.toFixed(1)),
    tick_expected_x: ticks.map(v => Math.round(g.x(v) - 12)),
    tick_labels: ticks.map(v => fmtClock(v)),
    measured_label_groups: groups.map(([a, b]) => ({ left: Math.round(a / dpr), right: Math.round(b / dpr) })),
    playhead_expected_t1_s: +g.t1.toFixed(2),
  };
})()`, true);
console.log('\n=== ČASOVÁ OSA GRAFU RINGU vs. PŘEHRÁVAČ ===');
console.log(JSON.stringify(out, null, 1));
chrome.kill(); serve.kill();
process.exit(0);
