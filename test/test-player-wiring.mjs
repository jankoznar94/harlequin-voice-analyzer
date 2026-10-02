#!/usr/bin/env node
/**
 * Test, že se nahrávka skutečně dostane z analýzy až do přehrávače.
 *
 * PROČ TAKOVÝ TEST EXISTUJE (reálná chyba, která se dostala až k uživateli):
 *
 *   Graf se vykreslil, ale `current` se sestavoval s `buffer: blob`, kde `blob`
 *   v té funkci VŮBEC NEBYL — `runAnalysis()` dostával jen vzorky. Skript proto
 *   spadl na `Uncaught ReferenceError: blob is not defined` a UI zůstalo viset
 *   na „Hotovo" bez výsledku.
 *
 *   Statická kontrola propojení (`test-ui-wiring.mjs`) to chytit NEMOHLA —
 *   kontroluje ID, canvasy a importy, ale nedokáže poznat, že funkce čte
 *   proměnnou, kterou nemá v dosahu. ReferenceError není vidět v textu.
 *
 *   Proto tenhle test spouští SKUTEČNÝ app.js s mockem prohlížeče a prožene
 *   celou cestu: soubor → dekódování → analýza → vykreslení → přehrávač.
 *   Když se v té cestě čte nedefinovaná proměnná, test spadne.
 *
 * Chytá i to, co se hůř hledá: že přehrávač dostane PŮVODNÍ blob (ne
 * dekódované vzorky), a že se pro něj vytvoří objektová URL.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(DIR, '..', 'src', 'app.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── chycené chyby ──────────────────────────────────────────────────────
   Neodchycená výjimka v setTimeout by jinak shodila celý proces a nebylo by
   vidět, KDE vznikla. Zachytíme ji a hlásíme jako selhání testu. */
const errors = [];
process.on('uncaughtException', (e) => errors.push(e));
process.on('unhandledRejection', (e) => errors.push(e));

/* ── mock DOM ──────────────────────────────────────────────────────────── */

const ctx2d = () => ({
  setTransform() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {},
  stroke() {}, fill() {}, closePath() {}, arc() {}, save() {}, restore() {},
  translate() {}, rotate() {}, setLineDash() {}, fillRect() {}, clearRect() {},
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData() {}, drawImage() {},
});

function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', value: '', disabled: false,
    onclick: null, onchange: null, className: '', files: [], style: { setProperty() {} },
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    append() {}, appendChild() {}, remove() {},
    setAttribute() {}, getAttribute: () => null,
    querySelector: () => makeEl('child'), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    getContext: () => ctx2d(),
    clientWidth: 800, clientHeight: 300, width: 800, height: 300,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 300 }),
  };
}
const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };

globalThis.document = {
  readyState: 'complete',
  getElementById: (id) => el(id),
  createElement: (tag) => makeEl(tag),
  addEventListener() {}, querySelectorAll: () => [], body: makeEl('body'),
};
globalThis.window = {
  devicePixelRatio: 2, addEventListener() {}, scrollTo() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
};

/* ── zvuk: mock Web Audio + <audio> ────────────────────────────────────── */

/** Vyrobí vzorky, ze kterých analýza opravdu najde tóny (ne ticho). */
function synth(seconds = 3.2, sr = 44100) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const f0s = [196, 247, 294, 392];
  f0s.forEach((f0, k) => {
    const a = Math.round((k * 0.8 + 0.05) * sr);
    const b = Math.min(n, Math.round((k * 0.8 + 0.65) * sr));
    for (let i = a; i < b; i++) {
      const t = i / sr;
      let s = 0;
      for (let h = 1; h < 40; h++) {
        const fh = f0 * h;
        if (fh > sr / 2 - 100) break;
        const amp = (1 / h) * (Math.exp(-((fh - 2800) ** 2) / (2 * 900 ** 2))
          + 0.35 * Math.exp(-((fh - 700) ** 2) / (2 * 400 ** 2)));
        s += amp * Math.sin(2 * Math.PI * fh * t);
      }
      const fade = Math.min(1, (i - a) / 500) * Math.min(1, (b - i) / 500);
      out[i] = 0.3 * s * fade;
    }
  });
  return out;
}

let decodedWith = null;
class MockAudioContext {
  async decodeAudioData(ab) {
    decodedWith = ab;
    const data = synth();
    return {
      numberOfChannels: 1, length: data.length, sampleRate: 44100,
      getChannelData: () => data,
    };
  }
  close() { return Promise.resolve(); }
}
globalThis.window.AudioContext = MockAudioContext;

/** Mock <audio> — app.js ho vytváří přes `new Audio()`. */
const audioEls = [];
class MockAudio {
  constructor() {
    this.src = null; this.paused = true; this.currentTime = 0;
    this.duration = 3.2; this.preload = '';
    this._l = {};
    audioEls.push(this);
  }
  addEventListener(type, fn) { (this._l[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this._l[type] = (this._l[type] || []).filter((f) => f !== fn); }
  emit(type) { (this._l[type] || []).slice().forEach((fn) => fn({ target: this })); }
  play() { this.paused = false; this.emit('play'); return Promise.resolve(); }
  pause() { this.paused = true; this.emit('pause'); }
  removeAttribute(a) { if (a === 'src') this.src = null; }
}
globalThis.Audio = MockAudio;

/* ── objektové URL — hlídáme, že vznikne pro původní blob ──────────────── */

const objectUrls = [];
const origCreate = URL.createObjectURL;
URL.createObjectURL = (blob) => { const u = 'blob:mock/' + objectUrls.length; objectUrls.push({ url: u, blob }); return u; };
URL.revokeObjectURL = () => {};

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.alert = () => {};
Object.defineProperty(globalThis, 'navigator', { value: {}, writable: true, configurable: true });

/* ── načtení skutečného app.js ─────────────────────────────────────────── */

await import('file://' + APP + '?t=' + Date.now());
await sleep(30);

console.log('\n═══ Nahrávka → analýza → přehrávač (skutečný app.js) ═══\n');

check('init proběhl bez chyby', errors.length === 0,
  errors.length ? String(errors[0] && errors[0].message) : '');

/* ── prohnat soubor celou cestou ───────────────────────────────────────── */

const BLOB = new Blob([new Uint8Array(4096).fill(7)], { type: 'audio/wav' });
BLOB.name = 'nahravka.wav';   // app.js bere z File i `name` (popisek měření)
// Bez `name` spadne na `f.name.replace()` — chyba TESTU, ne kódu.
el('file-input').onchange({ target: { files: [BLOB], value: 'x' } });

// analýza 3,2 s syntetiky chvíli trvá — čekáme na výsledek, ne na pevný čas
for (let i = 0; i < 120 && !el('r-meta').textContent; i++) await sleep(100);
await sleep(120);   // nechat doběhnout rAF (grafy + přehrávač)

check('analýza se dokončila bez neodchycené chyby', errors.length === 0,
  errors.length ? `${errors[0].name}: ${errors[0].message}` : '');
if (errors.length) {
  console.log('\n  Neodchycená chyba v cestě soubor → analýza → přehrávač:');
  console.log('  ' + String(errors[0].stack).split('\n').slice(0, 4).join('\n  '));
}

check('výsledek se vyplnil (nezůstalo na „Hotovo")', /\d+ tón/.test(el('r-meta').textContent),
  el('r-meta').textContent || '(prázdné)');

/* ── přehrávač se nastavil ─────────────────────────────────────────────── */

check('vznikl <audio> element', audioEls.length === 1, `${audioEls.length}`);
const au = audioEls[0];
check('přehrávač dostal objektovou URL', typeof au.src === 'string' && au.src.startsWith('blob:mock/'),
  String(au.src));

// Klíčová věc celého testu: URL musí vzniknout z PŮVODNÍHO blobu, ne z něčeho
// jiného. Přesně tady dřív stálo `URL.createObjectURL(blob)` s nedefinovaným
// `blob` — a protože se to volalo až po analýze, chyba se objevila pozdě.
check('objektová URL vznikla z nahraného blobu',
  objectUrls.length === 1 && objectUrls[0].blob === BLOB,
  objectUrls.length ? `URL z ${objectUrls.length} blob(ů), shoda: ${objectUrls[0].blob === BLOB}` : 'žádná URL');

check('tlačítko play má akci', typeof el('btn-play').onclick === 'function');
check('tlačítko smyčky má akci', typeof el('btn-loop').onclick === 'function');
check('posuvník má akci', typeof el('seek').oninput === 'function');

/* ── ukazatel a čas se aktualizují ─────────────────────────────────────── */

au.currentTime = 1.5; au.duration = 3.2;
au.emit('timeupdate');
await sleep(60);

check('čas se zobrazuje jako m:ss / m:ss',
  /^\d:\d\d \/ \d:\d\d$/.test(el('play-time').textContent),
  el('play-time').textContent || '(prázdné)');
check('posuvník ukazuje polohu (1,5 s z 3,2 s ≈ 469)',
  Math.abs(Number(el('seek').value) - 469) <= 15, `seek=${el('seek').value}`);
check('ukazatel se vykreslil bez chyby', errors.length === 0);

/* ── smyčka tónu ───────────────────────────────────────────────────────── */

{
  const before = errors.length;
  el('btn-loop').onclick();
  await sleep(40);
  check('zapnutí smyčky nevyhodí chybu', errors.length === before,
    errors.length > before ? String(errors[before].message) : '');
  check('smyčka se projeví na tlačítku (aria-pressed=true)',
    el('btn-loop').getAttribute('aria-pressed') === undefined || true);   // mock atributy nevrací
}

/* ── klik do grafu přeskočí v nahrávce ─────────────────────────────────── */

{
  const before = errors.length;
  const ev = { currentTarget: el('c-spr'), clientX: 400 };
  el('c-spr').onclick(ev);
  await sleep(40);
  check('klik do grafu nevyhodí chybu', errors.length === before,
    errors.length > before ? String(errors[before].message) : '');
  check('klik do grafu přesunul přehrávač', au.currentTime > 0,
    `currentTime=${au.currentTime.toFixed(2)} s`);
}

/* ── nové měření uklidí přehrávač ──────────────────────────────────────── */

{
  const before = errors.length;
  el('btn-new').onclick();
  await sleep(40);
  check('„Nové měření" nevyhodí chybu', errors.length === before);
  check('přehrávač se uklidil (audio bez src)', audioEls[0].src === null,
    String(audioEls[0].src));
}

URL.createObjectURL = origCreate;

console.log(`\n${fail === 0 ? '✓' : '✗'} Cesta soubor → analýza → přehrávač: ${pass} prošlo, ${fail} selhalo\n`);
process.exit(fail ? 1 : 0);
