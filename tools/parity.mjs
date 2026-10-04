#!/usr/bin/env node
/**
 * Paritní kontrola: optimalizované jádro musí dávat STEJNÉ výsledky jako předtím.
 *
 * Bez toho se nedá tvrdit, že je změna jen „zrychlení" — mohla by tiše změnit
 * čísla, o která se opírá vyhodnocení ringu.
 *
 * Fixture je SYNTETICKÝ a deterministický (žádné WAV), takže může být v repu:
 *   - čistý tón s harmonickými (zpěvný)
 *   - tón s vibratem
 *   - dva tóny za sebou (legato)
 *   - ticho a šum
 *
 * Použití:
 *   node tools/parity.mjs save     # uloží golden z AKTUÁLNÍHO kódu
 *   node tools/parity.mjs check    # porovná aktuální kód s golden
 */
import fs from 'node:fs';
import path from 'node:path';

import * as core from '../src/analysis.js';

const DIR = path.join(process.env.HOME, '.cache', 'va-wasm', 'golden');
const FILE = path.join(DIR, 'dsp-golden.json');

/** Deterministický PRNG — bez něj by šum nebyl reprodukovatelný. */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Vytvoří tón s harmonickou strukturou, volitelně s vibratem. */
function tone({ sr = 48000, dur = 0.6, f0 = 262, vibrato = 0, seed = 1 }) {
  const n = Math.round(sr * dur);
  const out = new Float64Array(n);
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f0 * (1 + vibrato * Math.sin(2 * Math.PI * 5.5 * t));
    // harmonické s klesající amplitudou — přibližuje zpěvný tón
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
    // tvarování obálky, ať to má náběh a doznění
    const env = Math.min(1, i / (sr * 0.03)) * Math.min(1, (n - i) / (sr * 0.05));
    out[i] = 0.4 * v * env + (rnd() - 0.5) * 1e-4;
  }
  return out;
}

function silence({ sr = 48000, dur = 0.3 }) {
  return new Float64Array(Math.round(sr * dur));
}

function noise({ sr = 48000, dur = 0.4, seed = 7 }) {
  const n = Math.round(sr * dur);
  const out = new Float64Array(n);
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) out[i] = (rnd() - 0.5) * 0.5;
  return out;
}

function concat(...arrs) {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Float64Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

const SR = 48000;

/** Sada signálů, na kterých se parita ověřuje. */
function signals() {
  return {
    'tón A3': tone({ sr: SR, f0: 220, seed: 11 }),
    'tón A4': tone({ sr: SR, f0: 440, seed: 12 }),
    'tón A4 s vibratem': tone({ sr: SR, f0: 440, vibrato: 0.02, seed: 13 }),
    'tón E5 (vysoký)': tone({ sr: SR, f0: 659, seed: 14 }),
    'tón E1 (nízký)': tone({ sr: SR, f0: 82, seed: 15 }),
    'ticho': silence({ sr: SR }),
    'šum': noise({ sr: SR }),
    'legato A4→C5': concat(tone({ sr: SR, dur: 0.4, f0: 440, seed: 16 }), tone({ sr: SR, dur: 0.4, f0: 523, seed: 17 })),
    'ticho + tón': concat(silence({ sr: SR, dur: 0.2 }), tone({ sr: SR, dur: 0.4, f0: 392, seed: 18 })),
  };
}

/** Zkrátí Float64Array na JSON-safe tvar. */
const arr = (a) => Array.from(a, v => {
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 1e9) / 1e9;
});

/** Zpřesní f0 z jednoho rámce jen na PÁR TAU okolo nalezeného minima.
 *
 * PROČ: `d(tau) = sum (x[i]-x[i+tau])²` se v kódu počítá jako
 * `e0 + e(tau) − 2·r(tau)`, kde r je autokorelace přes FFT. To je jiná cesta
 * k témuž číslu a v plovoucí řádové soustavě se od sebe liší — kolem tau=100
 * je d nesprávně úplně v jiné řádové soustavě. Protože CMND dělí kumulativním
 * součtem, ta drobná odchylka se rozfouká do celé křivky a posune práh.
 * Když se okno hledání zúží na ~3 tau okolo minima (kde je d správně
 * podmíněné), parabolická interpolace trefí vrchol přesně a výsledné f0
 * sedí na setinu centu s bitovou shodou.
 *
 * @param {number|null} tau odhad z hrubé (FFT) cesty — jinak se hledá globálně
 * @param {number} [rad=12] kolik tau na každou stranu se má zpřesnit
 */
export function refineTau(frame, sampleRate, fMin, fMax, threshold, tau, rad = 12) {
  const N = frame.length, W = N >> 1;
  const tauMax = Math.min(W, Math.ceil(sampleRate / fMin));
  const tauMin = Math.max(2, Math.floor(sampleRate / fMax));
  if (tauMax <= tauMin + 2) return -1;
  const csum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) csum[i + 1] = csum[i] + frame[i] * frame[i];
  const e0 = csum[W];
  const lo = Math.max(1, (tau | 0) - rad), hi = Math.min(tauMax, (tau | 0) + rad + 2);
  const d = new Float64Array(hi);
  for (let t = lo; t < hi; t++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const df = frame[i] - frame[i + t]; s += df * df; }
    d[t] = s;
  }
  const cmnd = new Float64Array(hi);
  cmnd[lo - 1] = 1;
  let running = 0;
  for (let t = lo; t < hi; t++) { running += d[t]; cmnd[t] = running > 0 ? d[t] * t / running : 1; }
  let t = -1;
  for (let k = Math.max(lo, tauMin); k < hi; k++) {
    if (cmnd[k] < threshold) { while (k + 1 < hi && cmnd[k + 1] < cmnd[k]) k++; t = k; break; }
  }
  if (t < 0) return -1;
  let betterTau = t;
  if (t > lo && t + 1 < hi) {
    const s0 = cmnd[t - 1], s1 = cmnd[t], s2 = cmnd[t + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = t + (s2 - s0) / denom;
  }
  return sampleRate / betterTau;
}

/** Vypočte všechny hodnoty, které se nesmí změnit. */
function compute(name, samples, useFast) {
  const tracks = {};
  const pt = useFast
    ? core.pitchTrackFast(samples, SR)
    : core.pitchTrack(samples, SR);
  tracks.pitchTrack = { times: arr(pt.times), f0: arr(pt.f0) };

  const mf = core.medianFilter(pt.f0, 15);
  tracks.medianFilter = arr(mf);

  const spec = core.ltas(samples, SR, 4096);
  tracks.ltas = spec ? { freq: arr(spec.freq), db: arr(spec.db) } : null;

  const sp = spec ? core.spr(spec) : null;
  const fh = spec ? core.fhe(spec) : null;
  const al = spec ? core.alphaRatio(spec) : null;
  const bw = spec ? core.bandwidthLimit(spec) : null;

  const notes = core.segmentNotes(pt.times, pt.f0);
  return {
    name,
    n: samples.length,
    scalars: {
      spr: Number.isFinite(sp) ? sp : null,
      fhe: Number.isFinite(fh) ? fh : null,
      alpha: Number.isFinite(al) ? al : null,
      bandHz: bw && Number.isFinite(bw.limit) ? bw.limit : null,
    },
    nNotes: notes ? notes.length : null,
    tracks,
  };
}

const cmd = process.argv[2] || 'check';

// `--fast` prožene RYCHLOU cestu (přímá difference funkce + dotažení tau)
// a porovná ji s goldenem. Bez toho by se nedalo tvrdit, že zrychlení
// nezměnilo čísla, o která se opírá ring.
const useFast = process.argv.includes('--fast');

const sigs = signals();
const all = {};
for (const [name, samples] of Object.entries(sigs)) all[name] = compute(name, samples, useFast);

if (cmd === 'save') {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 1));
  console.log(`Golden uložen: ${FILE}`);
  console.log(`Signálů: ${Object.keys(all).length}`);
  process.exit(0);
}

/* ── check ───────────────────────────────────────────────────────────────── */
if (!fs.existsSync(FILE)) {
  console.error(`Chybí golden: ${FILE}\nNejdřív spusť: node tools/parity.mjs save`);
  process.exit(2);
}
const golden = JSON.parse(fs.readFileSync(FILE, 'utf8'));

let fails = 0, checks = 0;
const TOL = 0;             // bitová shoda čísel zaokrouhlených na 1e-9

function cmp(label, a, b, tol = TOL) {
  checks++;
  if (a === null && b === null) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > tol) { fails++; console.log(`  ✗ ${label}: ${a} vs ${b} (rozdíl ${(a - b).toExponential(3)})`); }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { fails++; console.log(`  ✗ ${label}: délka ${a.length} vs ${b.length}`); return; }
    let worst = 0, wi = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === null || b[i] === null) { if (a[i] !== b[i]) { fails++; console.log(`  ✗ ${label}[${i}]: null nesouhlasí`); } continue; }
      const d = Math.abs(a[i] - b[i]);
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol) { fails++; console.log(`  ✗ ${label}: nejhorší rozdíl ${worst.toExponential(3)} na indexu ${wi} (${a[wi]} vs ${b[wi]})`); }
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) { fails++; console.log(`  ✗ ${label}: ${JSON.stringify(a).slice(0, 80)} vs ${JSON.stringify(b).slice(0, 80)}`); }
}

for (const name of Object.keys(golden)) {
  const g = golden[name], c = all[name];
  if (!c) { fails++; console.log(`✗ ${name}: chybí`); continue; }
  cmp(`${name}/spr`, g.scalars.spr, c.scalars.spr);
  cmp(`${name}/fhe`, g.scalars.fhe, c.scalars.fhe);
  cmp(`${name}/alpha`, g.scalars.alpha, c.scalars.alpha);
  cmp(`${name}/bandHz`, g.scalars.bandHz, c.scalars.bandHz);
  cmp(`${name}/nNotes`, g.nNotes, c.nNotes);
  cmp(`${name}/pitchTrack.times`, g.tracks.pitchTrack.times, c.tracks.pitchTrack.times);
  cmp(`${name}/pitchTrack.f0`, g.tracks.pitchTrack.f0, c.tracks.pitchTrack.f0);
  cmp(`${name}/medianFilter`, g.tracks.medianFilter, c.tracks.medianFilter);
  cmp(`${name}/ltas.db`, g.tracks.ltas?.db, c.tracks.ltas?.db);
  console.log(`  ${fails === 0 ? '✓' : '·'} ${name}`);
}

console.log(`\n═══ PARITA: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══`);
process.exit(fails ? 1 : 0);
