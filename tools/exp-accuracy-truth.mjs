#!/usr/bin/env node
/**
 * EXPERIMENT 2: skutečná PŘESNOST metod SPR vůči ZNÁMÉ PRAVDĚ.
 *
 * Předchozí experiment (exp-accuracy.mjs) ukázal, že všechny metody se mezi
 * sebou shodují lépe (r = 0,995), než každá sama se sebou mezi dvěma polovinami
 * téhož tónu (~3,8 dB). To znamená, že hlavní zdroj chyby NENÍ metoda, ale tón.
 * Jenže „opakovatelnost" ještě není „přesnost" — metoda může být dokonale
 * opakovatelná a přitom systematicky vedle.
 *
 * Tady se proto měří PŘESNOST: vyrobí se tón, u kterého je SPR spočítatelný
 * Z DEFINICE (harmonické s předepsanou amplitudou → poměr dvou vrcholů je
 * dán amplitudami, okno se vykrátí), a porovná se, co která metoda vrátí.
 *
 * Případy jsou zvolené tak, aby odpovídaly tomu, co Jan skutečně nahrává:
 *   A) čistý držený tón                        (základ)
 *   B) s vibratem 5,5 Hz / 3 %                 (reálný zpěv)
 *   C) s doprovodným tónem −18 dBFS            (klavír/orchestr pod hlasem!)
 *   D) se šumem −30 dBFS                       (telefon, místnost)
 *   E) krátký tón 0,45 s                       (běžná nota v melodii)
 *
 * Použití: node tools/exp-accuracy-truth.mjs
 */
import { ltas, spr, spectralEnvelope } from '../src/analysis.js';

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
const sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); };

/** Rezonanční obálka hlasu: tři formanty + shluk zpěváckého formantu (F3-F5). */
function gain(f) {
  const res = (fc, bw, a) => a / (1 + ((f - fc) / bw) ** 2);
  return res(500, 120, 1.0) + res(1500, 180, 0.45) + res(2500, 220, 0.30)
       + res(3000, 250, 0.22) + res(3500, 300, 0.10);
}

/** Amplitudy harmonických h=1..H podle obálky a zdrojového spádu. */
function harmAmps(f0, H) {
  const A = [];
  for (let h = 1; h <= H; h++) A.push(gain(h * f0) / h ** 0.9);
  return A;
}

/** PRAVDA: SPR je z definice poměr amplitud dvou největších harmonických
 *  v pásmech (okno i normalizace se vykrátí, protože jsou pro obě stejné). */
function trueSPR(f0, extraHi = 0) {
  const A = harmAmps(f0, Math.floor(4000 / f0));
  let lo = 0, hi = 0;
  for (let h = 1; h <= A.length; h++) {
    const f = h * f0;
    let a = A[h - 1];
    if (f >= 2000 && f <= 4000 && extraHi) a *= 1;   // doprovod se sem nepočítá
    if (f > 0 && f < 2000) lo = Math.max(lo, a);
    if (f >= 2000 && f <= 4000) hi = Math.max(hi, a);
  }
  if (!lo || !hi) return NaN;
  return 20 * Math.log10(hi / lo);
}

function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** Tón s předepsanou harmonickou strukturou (fáze se INTEGRUJE). */
function synth({ sr = 48000, dur = 1.0, f0 = 262, vibDepth = 0, vibRate = 5.5,
                 accompHz = 0, accompDb = -18, noiseDb = -60, seed = 3 }) {
  const n = Math.round(sr * dur);
  const H = Math.floor(4000 / f0);
  const A = harmAmps(f0, H);
  const rnd = mulberry32(seed);
  const out = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f0 * (1 + vibDepth * Math.sin(2 * Math.PI * vibRate * t));
    ph += 2 * Math.PI * f / sr;
    let v = 0;
    for (let h = 1; h <= H; h++) v += A[h - 1] * Math.sin(h * ph);
    const env = Math.min(1, i / (sr * 0.05)) * Math.min(1, (n - i) / (sr * 0.10));
    out[i] = 0.3 * v * env;
  }
  if (accompHz) for (let i = 0; i < n; i++) out[i] += Math.pow(10, accompDb / 20) * Math.sin(2 * Math.PI * accompHz * i / sr);
  if (noiseDb > -90) {
    const na = Math.pow(10, (noiseDb - 3) / 20);
    for (let i = 0; i < n; i++) out[i] += (rnd() - 0.5) * 2 * na;
  }
  return out;
}

/* ── metody ────────────────────────────────────────────────────────────── */
function peakInterp(spec, lo, hi) {
  const { freq, db } = spec;
  let bi = -1, bv = -Infinity;
  for (let i = 0; i < freq.length; i++) if (freq[i] >= lo && freq[i] <= hi && db[i] > bv) { bv = db[i]; bi = i; }
  if (bi <= 0 || bi >= freq.length - 1) return bv;
  const y0 = db[bi - 1], y1 = db[bi], y2 = db[bi + 1];
  const den = y0 - 2 * y1 + y2;
  if (den === 0) return bv;
  const d = 0.5 * (y0 - y2) / den;
  if (Math.abs(d) > 1) return bv;
  return y1 - 0.25 * (y0 - y2) * d;
}

const METHODS = {
  m1_dnes:      (x, sr) => spr(ltas(x, sr, 4096)),
  m2_interp:    (x, sr) => peakInterp(ltas(x, sr, 4096), 2000, 4000) - peakInterp(ltas(x, sr, 4096), 30, 2000),
  m3_8192:      (x, sr) => { const s = ltas(x, sr, 8192); return peakInterp(s, 2000, 4000) - peakInterp(s, 30, 2000); },
  m4_16384:     (x, sr) => { const s = ltas(x, sr, 16384); return peakInterp(s, 2000, 4000) - peakInterp(s, 30, 2000); },
  m5_obalka:    (x, sr) => {
    const e = spectralEnvelope(ltas(x, sr, 4096), 0.01);
    const band = (a, b) => { let s = 0, n = 0; for (let i = 0; i < e.freq.length; i++) if (e.freq[i] >= a && e.freq[i] <= b) { s += e.db[i]; n++; } return n ? s / n : NaN; };
    return band(2000, 4000) - band(200, 2000);
  },
  /* POZOR na měřítko: obálkové a pásmové průměry NEJSOU SPR (jiná veličina).
   * Porovnávat s pravdou SPR má smysl jen u metod, které měří tentýž poměr
   * dvou vrcholů. Tady se to nechává vidět, ať je zřejmé, že „vzít průměr
   * ze všeho" míchá různé veličiny. */
};

const CASES = {
  'A čistý 1,0 s':     { dur: 1.0 },
  'B vibrato 3 %':     { dur: 1.0, vibDepth: 0.03 },
  'C doprovod −18':    { dur: 1.0, accompHz: 880, accompDb: -18 },
  'D šum −30':         { dur: 1.0, noiseDb: -30 },
  'E krátký 0,45 s':   { dur: 0.45 },
};

const F0S = [196, 220, 247, 262, 294, 330, 349, 392, 440, 494];
const sr = 48000;

console.log('PŘESNOST VŮČI ZNÁMÉ PRAVDĚ (10 tónů, stejné pro všechny metody)');
console.log('chyba = změřené − pravé   (záporné = metoda podhodnocuje)\n');
const names = Object.keys(METHODS);
console.log('případ'.padEnd(18) + names.map(n => n.padStart(22)).join(''));
for (const [cname, opt] of Object.entries(CASES)) {
  const cells = [];
  for (const k of names) {
    const errs = [];
    for (const f0 of F0S) {
      const x = synth({ sr, f0, ...opt });
      const truth = trueSPR(f0);
      const got = METHODS[k](x, sr);
      if (truth === truth && got === got) errs.push(got - truth);
    }
    cells.push(`bias ${mean(errs).toFixed(2).padStart(6)} SD ${sd(errs).toFixed(2).padStart(5)}`);
  }
  console.log(cname.padEnd(18) + cells.map(c => c.padStart(22)).join(''));
}

console.log('\nTOTÉŽ JAKO „JAK DALEKO OD PRAVDY" (střední absolutní chyba, dB):');
console.log('případ'.padEnd(18) + names.map(n => n.padStart(12)).join(''));
for (const [cname, opt] of Object.entries(CASES)) {
  const cells = [];
  for (const k of names) {
    const errs = [];
    for (const f0 of F0S) {
      const x = synth({ sr, f0, ...opt });
      const truth = trueSPR(f0);
      const got = METHODS[k](x, sr);
      if (truth === truth && got === got) errs.push(Math.abs(got - truth));
    }
    cells.push(median(errs).toFixed(2).padStart(12));
  }
  console.log(cname.padEnd(18) + cells.join(''));
}

console.log('\nPRAVÉ SPR pro ty tóny (aby bylo vidět, o jak velký rozptyl jde):');
const tr = F0S.map(f => trueSPR(f));
console.log('  ' + tr.map((v, i) => `${F0S[i]}:${v.toFixed(1)}`).join('  '));
console.log(`  medián ${median(tr).toFixed(2)} dB, SD ${sd(tr).toFixed(2)} dB`);

/* ── rozhodující otázka: pomůže průměr metod? ─────────────────────────── */
console.log('\nPOMŮŽE PRŮMĚR METOD? (jen metody, které měří TOTÉŽ — m1..m4)');
const same = ['m1_dnes', 'm2_interp', 'm3_8192', 'm4_16384'];
for (const [cname, opt] of Object.entries(CASES)) {
  const errsAvg = [], errsBest = [];
  for (const f0 of F0S) {
    const x = synth({ sr, f0, ...opt });
    const truth = trueSPR(f0);
    const vals = same.map(k => METHODS[k](x, sr)).filter(v => v === v);
    if (!vals.length) continue;
    errsAvg.push(mean(vals) - truth);
    errsBest.push(vals[2] - truth);      // m3_8192 samostatně
  }
  console.log(`  ${cname.padEnd(18)} průměr 4 metod: |chyba| ${median(errsAvg.map(Math.abs)).toFixed(2)} dB   m3_8192 sám: ${median(errsBest.map(Math.abs)).toFixed(2)} dB`);
}
