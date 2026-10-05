#!/usr/bin/env node
/**
 * Ověří V PROHLÍŽEČI, že živý režim ukáže délku vokálního traktu (#lv-vtl).
 *
 * Proč prohlížeč a ne jen Node: živá cesta jde přes AudioWorklet a `getUserMedia`,
 * takže se v Node ověří jen jádro. Tady se ověří CELÁ cesta až k dlaždici —
 * a hlavně že dlaždice NENÍ prázdná (dřívější chyba: prvek v DOM byl a nikdo ho
 * neplnil).
 *
 * Dvě pasti, které to jinak tiše rozbíjí:
 *   1. `getUserMedia` se MUSÍ přepsat na PROTOTYPU. Když se přiřadí na instanci,
 *      Chromium zavolá původní metodu a test vypadá, že „stub se nezavolal,
 *      a přesto to funguje".
 *   2. Zvuk se pouští do `createMediaStreamDestination()`, ne do reproduktoru.
 *
 * ⚠️ Emoji: v `index.html` ani v JS nesmí být žádné — hlídá to test-live-wiring.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 9381);
const PROFILE = join(process.env.HOME, '.cache/va-live-vtl' + PORT);
const APP_URL = process.env.APP_URL || 'http://localhost:8123/index.html';
const W = Number(process.env.W || 390);
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn('chromium-browser', ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  `--window-size=${W},900`, '--autoplay-policy=no-user-gesture-required', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 40; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = l.find(t => t.type === 'page');
    if (p?.webSocketDebuggerUrl) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(250);
}
if (!ws) { console.error('CDP se nepřipojilo'); chrome.kill(); process.exit(1); }
await new Promise(r => ws.onopen = r);

let id = 0; const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
});
async function ev(expr, aw = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw });
  if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text) };
  return r.result.value;
}

let fails = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  // POZOR — úklid service workeru PŘED načtením, jinak test čte starý index.html
  await ev(`(async () => {
    try { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(x => x.unregister())); } catch (e) {}
    try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (e) {}
    return 'sw uklizen'; })()`, true);
  await send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  await ev(`(() => { window.__err = []; window.__dialogs = [];
    window.alert = m => window.__dialogs.push(String(m));
    window.addEventListener('error', e => window.__err.push(String(e.message))); return 'ok'; })()`);

  console.log('\n=== PŘÍPRAVA MIKROFONU ===');
  /* Signál se do stránky posílá jako VZORKY, ne přes oscilátor s BiquadFiltery.
   * Důvod je naměřený: oscilátor dává jen základní tón (jedna harmonická),
   * takže LPC nemá z čeho postavit formanty a vyjde harmonická místo nich
   * (v testu pak 21,6 cm místo 17,2). Tady se vyrobí tentýž signál jako v Node
   * testu — harmonická řada pod rezonanční obálkou traktu — a předá se jako
   * AudioBufferSourceNode. Tím se ověří CELÁ cesta včetně AudioWorkletu. */
  const stub = await ev(`(() => {
    if (!navigator.mediaDevices) return 'mediaDevices chybí';
    const SR = 44100;                     // stejné, jaké hlásí jádro
    const f0 = 146.83;                   // D3
    const g = (f) => {
      const r = (fc, bw, a) => a / (1 + ((f - fc) / bw) ** 2);
      return r(500, 120, 1.0) + r(1500, 180, 0.45) + r(2500, 220, 0.30)
           + r(3000, 250, 0.22) + r(3500, 300, 0.10);
    };
    const n = SR * 6;
    const data = new Float32Array(n);
    let fi = 0;
    for (let i = 0; i < n; i++) {
      fi += 2 * Math.PI * f0 / SR;
      let s = 0;
      for (let h = 1; h * f0 < 6000; h++) s += (g(h * f0) / h) * Math.sin(h * fi);
      const fade = Math.min(1, i / 1200) * Math.min(1, (n - i) / 1200);
      data[i] = 0.25 * s * fade;
    }
    Object.getPrototypeOf(navigator.mediaDevices).getUserMedia = async () => {
      const ctx0 = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
      const dst = ctx0.createMediaStreamDestination();
      const buf = ctx0.createBuffer(1, n, SR);
      buf.copyToChannel(data, 0);
      const src = ctx0.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(dst);
      src.start();
      window.__zdroj = src;
      return dst.stream;
    };
    return 'stub nastaven na prototype, signál = harmonická řada s formanty 500/1500/2500';
  })()`, true);
  console.log('  ' + stub);

  // Spustit živý režim kliknutím na tlačítko
  await ev(`(() => { document.getElementById('btn-live').click(); return 'klik'; })()`);
  await sleep(4000);          // tón musí držet dost na 3 okna

  console.log('\n=== ŽIVÝ PANEL ===');
  const stav = await ev(`(() => {
    const g = (i) => { const n = document.getElementById(i); return n ? n.textContent : 'CHYBI'; };
    return {
      vtl: g('lv-vtl'),
      panelVidet: !document.getElementById('panel-live').classList.contains('hidden'),
      eng: g('live-engine'),
      warn: (document.getElementById('live-warn') || {}).textContent,
      errs: window.__err, dialogs: window.__dialogs,
    };
  })()`);
  console.log('  panel živě vidět:', stav.panelVidet, '| jádro:', stav.eng);
  console.log('  délka traktu:', JSON.stringify(stav.vtl));
  if (stav.errs && stav.errs.length) console.log('  CHYBY:', stav.errs.join(' | '));
  if (stav.dialogs && stav.dialogs.length) console.log('  DIALOGY:', stav.dialogs.join(' | '));

  ok('živý panel se otevřel', stav.panelVidet === true);
  ok('dlaždice #lv-vtl v HTML existuje', stav.vtl !== 'CHYBI');
  ok('v dlaždici je ČÍSLO (ne prázdno a ne „—")',
    typeof stav.vtl === 'string' && /^\d+\.\d\s?cm$/.test(stav.vtl), JSON.stringify(stav.vtl));
  if (typeof stav.vtl === 'string' && /^\d/.test(stav.vtl)) {
    const cm = parseFloat(stav.vtl);
    ok('číslo je fyziologické (12–22 cm)', cm >= 12 && cm <= 22, `${cm} cm`);
    ok('číslo sedí na pravdu 17,15 cm (do 1 cm)', Math.abs(cm - 17.15) < 1.0, `odchylka ${(cm - 17.15).toFixed(2)} cm`);
  }
  ok('žádná chyba v konzoli', !(stav.errs && stav.errs.length), (stav.errs || []).join(' | '));
  ok('žádný alert (tichý pád by se jinak neprojevil)', !(stav.dialogs && stav.dialogs.length), (stav.dialogs || []).join(' | '));

  // Ukončit živý režim — souhrn se musí uložit do historie s VTL
  await ev(`(() => { document.getElementById('btn-live-save').click(); return 'ok'; })()`);
  await sleep(600);
  const hist = await ev(`(() => {
    const raw = localStorage.getItem('vocal-lab.history.v1');
    if (!raw) return null;
    const rows = JSON.parse(raw);
    return rows.length ? { vtl_cm: rows[0].vtl_cm, vtl_n: rows[0].vtl_n, live: rows[0].live } : null;
  })()`);
  console.log('\n=== HISTORIE ===');
  console.log('  ', JSON.stringify(hist));
  ok('živé měření se uložilo s délkou traktu',
    hist && Number.isFinite(hist.vtl_cm) && hist.vtl_cm >= 12 && hist.vtl_cm <= 22,
    hist ? `${hist.vtl_cm?.toFixed(2) ?? hist.vtl_cm} cm z ${hist.vtl_n} tónů` : 'žádný záznam');
} finally {
  try { ws.close(); } catch {}
  chrome.kill();
}

console.log(`\n=== ${fails ? fails + ' SELHALO' : 'VŠE V POŘÁDKU'} ===\n`);
process.exitCode = fails ? 1 : 0;
