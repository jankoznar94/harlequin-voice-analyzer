#!/usr/bin/env node
/**
 * Náhled a MĚŘENÍ grafu ringu ze staženého JSONu analýzy (bez zvukového souboru).
 *
 * PROČ: uživatel nahrává přímo v aplikaci a posílá jen JSON. Snímek z reálné
 * nahrávky (`shot-spr.mjs`) na to nestačí, protože zvuk nemáme. Přitom právě
 * čitelnost grafu (kolik px dostane jeden tón) se z JSONu spočítat DÁ — graf
 * závisí jen na `notes`, `summary` a `duration_s`.
 *
 * Co vypíše:
 *  - `need`/`canvasW`/`px na sekundu` a kolik sekund nahrávky se vejde do
 *    viditelného okna (to je ta vada „graf skončí dřív než nahrávka“)
 *  - POČET SOUVISLÝCH ÚSEKŮ KRESBY: kolik tónů je v grafu rozeznatelných
 *    (tóny se slévají, když je na ně málo pixelů) — naměřeno z pixelů plátna
 *  - kam až kresba sahá (`poslední inkoust na x = …px z …px`)
 *
 * Použití:
 *   node tools/shot-spr-json.mjs <analyza.json> [out.png] [availW] [scrollLeft]
 *   APP_URL=… node tools/shot-spr-json.mjs …   # měří produkci (bez JSONu z repa)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { guard } from '../test/lib/chrome-guard.mjs';

const FILE = process.argv[2];
const OUT = process.argv[3] || '/tmp/spr-json.png';
const AVAIL = Number(process.argv[4] || process.env.AVAIL || 330);
const SCROLL = Number(process.argv[5] || 0);
const PORT = Number(process.env.PORT || 8139);
const CDP_PORT = Number(process.env.CDP_PORT || 9363);
const CHROME = process.env.CHROME || 'chromium-browser';
const PROFILE = path.join(process.env.HOME, '.cache', 'va-chrome-shot-json');
const APP_URL = process.env.APP_URL || '';

if (!FILE || !existsSync(FILE)) { console.error(`chybí JSON ${FILE}`); process.exit(2); }
const data = JSON.parse(readFileSync(FILE, 'utf8'));

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
if (!APP_URL) await new Promise(r => server.listen(PORT, r));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1200,1400', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const stop = guard({ chrome, server, port: CDP_PORT, hardTimeoutMs: 180000 });
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
  await send('Page.navigate', { url: APP_URL || `http://localhost:${PORT}/index.html` });
  await sleep(3000);
  if (!APP_URL) {
    await send('Runtime.evaluate', { expression: `(async () => {
      const rs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(rs.map(x => x.unregister()));
      for (const k of await caches.keys()) await caches.delete(k);
      return 'ok';
    })()`, awaitPromise: true });
    await send('Page.reload', { ignoreCache: true });
    await sleep(3000);
  }

  const expr = `(async () => {
    const m = await import('/src/charts.js');
    const d = ${JSON.stringify({ notes: data.notes, summary: data.summary, duration_s: data.duration_s })};
    const avail = ${AVAIL};
    document.getElementById('panel-result')?.classList.remove('hidden');
    document.getElementById('tab-spr')?.click();
    const need = m.sprNeededWidth(avail, d.notes, d.duration_s);
    const w = need || avail;
    const wrap = document.querySelector('#pane-spr .chart-wrap');
    wrap.classList.remove('hidden');
    wrap.style.width = avail + 'px';
    wrap.classList.toggle('scrollable', !!need);
    const cv = document.getElementById('c-spr');
    cv.style.width = w + 'px';
    const g = m.drawSpr(cv, d.notes, d.summary, null,
      { width: w, offX: ${SCROLL}, duration: d.duration_s });
    if (!g) return { chyba: 'geometrie null' };
    wrap.scrollLeft = ${SCROLL};
    const pxPerS = g.plotW / g.t1;
    /* Které tóny jsou v grafu ROZEZNATELNÉ: tón, který dostal méně než ~1,5 px
     * šířky, splyne se sousedem. Sléváme tóny, jejichž intervaly se překrývají
     *  nebo leží blíž než 1,5 px. Počítá se z GEOMETRIE (stejná funkce, kterou
     *  kresba používá), ne z pixelů — pásma pozadí a mřížka by pixely zmátly
     *  (naměřeno: „1 souvislý úsek“ i na grafu, kde tóny vidět jsou). */
    const iv = d.notes.filter(n => n.spr === n.spr).map(n => [g.x(n.t_start), g.x(n.t_end)]);
    let cl = [];
    for (const [a, b] of iv) {
      const last = cl[cl.length - 1];
      if (last && a - last[1] < 1.5) last[1] = Math.max(last[1], b);
      else cl.push([a, b]);
    }
    const sirky = cl.map(([a, b]) => b - a).sort((x, y) => x - y);
    /* Kde je v plátně INKOUST TÓNŮ (zelená/červená/šedá značka tónu) — mřížka,
     * pásma pozadí ani popisky se nepočítají. Odpovídá to na otázku „kresba
     * skončila dřív, než nahrávka?“ jinak než odhadem z obrázku. */
    const ctx = cv.getContext('2d');
    const dpr2 = window.devicePixelRatio || 1;
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const tone = [[106, 158, 106], [181, 103, 94], [111, 104, 98]];
    const blizko = (r, g2, b, c, tol) => Math.abs(r - c[0]) <= tol && Math.abs(g2 - c[1]) <= tol && Math.abs(b - c[2]) <= tol;
    const sloupecTon = new Array(cv.width).fill(0);
    for (let py = 0; py < cv.height; py++) {
      for (let px = 0; px < cv.width; px++) {
        const i = (py * cv.width + px) * 4;
        const r = img[i], g2 = img[i+1], b = img[i+2];
        if (tone.some(c => blizko(r, g2, b, c, 26))) sloupecTon[px]++;
      }
    }
    const hist = new Array(20).fill(0);
    for (let x = 0; x < cv.width; x++) if (sloupecTon[x] > 0) hist[Math.min(19, Math.floor(x / cv.width * 20))]++;
    return {
      need, w, plotW: g.plotW, t1: g.t1, pxPerS,
      visibleTo: (avail - g.padL) / pxPerS,
      dpr: window.devicePixelRatio || 1,
      uzeke: cl.length,
      siroka: sirky[sirky.length >> 1],
      neuzke: sirky.filter(s => s < 1.5).length,
      sirkyVsechny: sirky.map(s => Math.round(s)),
      tonPrvni: sloupecTon.findIndex(v => v > 0),
      tonPosledni: cv.width - 1 - [...sloupecTon].reverse().findIndex(v => v > 0),
      tonSloupcu: sloupecTon.filter(v => v > 0).length,
      hist20: hist,
      rect: (({ x, y, width, height }) => ({ x, y, width, height }))(wrap.getBoundingClientRect()),
    };
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('v prohlížeči: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  const v = r.result.value;
  if (v.chyba) throw new Error(v.chyba);
  console.log(`avail(okno)=${AVAIL}px  potřeba=${v.need}  plátno=${v.w}px  plotW=${v.plotW}  t1=${v.t1.toFixed(2)}s`);
  console.log(`  ${v.pxPerS.toFixed(2)} px/s   okno vidí do t=${v.visibleTo.toFixed(1)}s   (nahrávka ${v.t1.toFixed(1)}s)`);
  console.log(`  ROZEZNATELNÝCH TÓNŮ: ${v.uzeke} z ${data.notes.length}   (medián šířky tónu ${v.siroka.toFixed(1)} px, tónů pod 1,5 px: ${v.neuzke})`);
  console.log(`  inkoust tónů od x=${(v.tonPrvni / v.dpr).toFixed(0)} do x=${(v.tonPosledni / v.dpr).toFixed(0)} px z ${(v.w).toFixed(0)} CSS px, ve ${v.tonSloupcu} sloupcích z ${(v.w * v.dpr).toFixed(0)}`);
  console.log(`  rozložení po šířce (20 dílů): ${v.hist20.join(' ')}`);
  console.log(`  šířky tónů (CSS px): ${v.sirkyVsechny.join(' ')}`);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
    clip: { x: v.rect.x, y: v.rect.y, width: Math.min(v.rect.width, AVAIL), height: v.rect.height, scale: 1 } });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('snímek: ' + OUT);
  stop(0);
})().catch(e => { console.error('CHYBA: ' + e.message); stop(1); });
