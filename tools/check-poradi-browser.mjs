#!/usr/bin/env node
// Ověří v REÁLNÉ aplikaci (index.html + app.js), že výsledková stránka stojí
// v pořadí, které uživatel potřebuje: NEJDŘÍV přehrávač s grafy, teprve POD
// nimi souhrn s čísly.
//
//   (a) `.player` i `.chart-tabs` leží NAD dlaždicemi s čísly (`.kpis`),
//   (b) dlaždice, vysvětlivka a verdikt jsou POD grafy — stránka se dá číst
//       shora dolů a k přehrávači se nemusí proklikávat,
//   (c) graf i překryvné plátno mají ve všech záložkách stejnou výšku a graf
//       začíná na stejném y (jinak přepnutí záložky uskočí obsahem),
//   (d) tabulka naměřených hodnot zůstala až za vším.
// Nahrávka se vyrobí synteticky (tóny nad G4), aby měl graf ladění co kreslit.
//
// ⚠️ Pořadí se NESMÍ ověřovat jen podle textu HTML (statický test v
// `test/test-ui-wiring.mjs` vidí jen zápis, ne skutečnou stránku) — tady se
// čtou skutečné y-souřadnice prvků v prohlížeči.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 9349);
const PROFILE = join(process.env.HOME, '.cache/va-cdp' + PORT);
const APP_URL = process.env.APP_URL || 'http://localhost:8123/index.html';
mkdirSync(PROFILE, { recursive: true });

// ── syntetická nahrávka: 4 tóny v rozsahu, dva nad G4 (kvůli grafu ladění) ──
const SR = 48000;
function synth() {
  const notes = [[392, 1.2], [523.25, 1.2], [659.25, 1.2], [783.99, 1.2]];
  const gap = Math.round(0.35 * SR);
  const total = notes.reduce((a, [f, d]) => a + Math.round(d * SR), 0) + gap * (notes.length - 1);
  const x = new Float64Array(total);
  let o = 0;
  for (const [f0, dur] of notes) {
    const n = Math.round(dur * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let s = 0;
      // harmonická řada s formantovým maximem ~2,9 kHz (zpěvácký formant)
      for (let h = 1; h < 60; h++) {
        const fh = f0 * h;
        if (fh > SR / 2 - 200) break;
        const env = Math.exp(-((fh - 2900) ** 2) / (2 * 900 ** 2)) + 0.5 * Math.exp(-((fh - 700) ** 2) / (2 * 400 ** 2));
        s += (1 / h) * env * Math.sin(2 * Math.PI * fh * t);
      }
      const fade = Math.min(1, i / (0.02 * SR)) * Math.min(1, (n - i) / (0.05 * SR));
      x[o + i] = 0.35 * s * fade;
    }
    o += n + gap;
  }
  // 16bit PCM WAV
  const buf = Buffer.alloc(44 + x.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + x.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  return buf;
}
const wav = synth();
const wavB64 = wav.toString('base64');

const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find(t => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(250);
}
if (!ws) { console.error('CDP se nepřipojilo'); process.exit(1); }
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text) };
  return r.result.value;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: APP_URL });
await sleep(3000);
setInterval(() => { send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }, 400);

// service worker v headless prostředí drží staré assety — vypnout
await evalJs(`(async () => {
  const rs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(rs.map(r => r.unregister()));
  const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k)));
  return true;
})()`, true);

// soubor do stránky a spuštění analýzy
await evalJs(`(() => {
  window.__err = [];
  window.addEventListener('error', e => window.__err.push(String(e.message)));
  const bin = atob(${JSON.stringify(wavB64)});
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([u8], 'test-zalozky.wav', { type: 'audio/wav' }));
  const inp = document.getElementById('file-input');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

// čekej na výsledek
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const st = await evalJs(`(() => {
    const r = document.getElementById('panel-result');
    return { url: location.pathname,
             hasTab: !!document.getElementById('tab-spr'),
             hidden: r ? r.classList.contains('hidden') : null,
             notes: document.querySelectorAll('#t-notes tbody tr').length };
  })()`);
  if (st && !st.hidden && st.notes > 0) { ready = true; console.log(`analýza hotova: ${st.notes} tónů`); break; }
  if (st && st.__err) { console.log('CHYBA ve stránce:', st.__err); }
}
if (!ready) console.log('⚠ analýza nedoběhla — měřím jen rozměry panelů');

const probe = [
  "(function () {",
  "  var log = [];",
  "  function ok(n, c, d) { log.push((c ? 'OK   ' : 'FAIL ') + n + (d ? '  - ' + d : '')); }",
  "  function q(sel) { return document.querySelector(sel); }",
  "  function top(sel) { var e = q(sel); return e ? +e.getBoundingClientRect().top.toFixed(1) : NaN; }",
  "  function bot(sel) { var e = q(sel); return e ? +e.getBoundingClientRect().bottom.toFixed(1) : NaN; }",
  "  var tTabs = top('.chart-tabs'), tPlayer = top('.player'), tKpis = top('.kpis');",
  "  var tVerdict = top('#r-verdict'), tNote = top('.note'), tTable = top('#t-notes');",
  "  var bPanes = bot('.chart-panes');",
  "  ok('grafove zalozky lezi NAD dlazdicemi s cisly', tTabs < tKpis, 'tabs ' + tTabs + ' vs kpis ' + tKpis);",
  "  ok('prehravac lezi NAD dlazdicemi s cisly', tPlayer < tKpis, 'player ' + tPlayer + ' vs kpis ' + tKpis);",
  "  ok('verdikt zacina na konci grafu nebo pod nim', tVerdict >= bPanes - 1, 'verdikt ' + tVerdict + ' vs konec grafu ' + bPanes);",
  "  ok('dlazdice s cisly jsou POD grafy', tKpis > bPanes, 'kpis ' + tKpis + ' vs ' + bPanes);",
  "  ok('vysvetlivka je POD dlazdicemi', tNote > tKpis, 'note ' + tNote + ' vs kpis ' + tKpis);",
  "  ok('tabulka namerenych hodnot je az za vsim', tTable > tNote, 'tabulka ' + tTable + ' vs vysvetlivka ' + tNote);",
  "  ok('nic z toho pod grafy neni skryte', !q('#r-body').classList.contains('hidden'));",
  "  var panes = ['spr', 'spec', 'f1'], res = {};",
  "  for (var i = 0; i < panes.length; i++) {",
  "    var w = panes[i];",
  "    document.getElementById('tab-' + w).click();",
  "    var cv = document.getElementById('c-' + w), head = document.getElementById('c-' + w + '-head');",
  "    res[w] = { cvTop: +cv.getBoundingClientRect().top.toFixed(1),",
  "               cvH: +cv.getBoundingClientRect().height.toFixed(1),",
  "               headH: +head.getBoundingClientRect().height.toFixed(1),",
  "               kpisTop: +q('.kpis').getBoundingClientRect().top.toFixed(1) };",
  "  }",
  "  function eq(k) { return Math.abs(res.spr[k] - res.spec[k]) < 1.05 && Math.abs(res.spr[k] - res.f1[k]) < 1.05; }",
  "  ok('graf ma ve vsech zalozkach stejnou vysku', eq('cvH'), panes.map(function (w) { return w + ' ' + res[w].cvH; }).join(', '));",
  "  ok('prekryvne platno sedi na graf', panes.every(function (w) { return Math.abs(res[w].cvH - res[w].headH) < 1.05; }));",
  "  ok('graf zacina ve vsech zalozkach na stejnem y', eq('cvTop'), panes.map(function (w) { return w + ' ' + res[w].cvTop; }).join(', '));",
  "  ok('dlazdice s cisly se pri prepnuti nepohnou', eq('kpisTop'), panes.map(function (w) { return w + ' ' + res[w].kpisTop; }).join(', '));",
  "  return log.join(String.fromCharCode(10)) + String.fromCharCode(10) + 'CHYBY: ' + JSON.stringify(window.__err || []);",
  "})()",
].join(String.fromCharCode(10));

const out = await evalJs(probe);

console.log(out);
chrome.kill('SIGKILL');
process.exit(0);
