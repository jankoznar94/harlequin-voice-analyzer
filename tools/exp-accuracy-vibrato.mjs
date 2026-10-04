#!/usr/bin/env node
/**
 * EXPERIMENT 4: dá se odstranit systematická chyba od VIBRATA?
 *
 * Naměřeno: tón s vibratem 3 % vychází o 4,6 dB níž, než je pravda. Není to
 * náhodný šum (SD 0,65 dB), je to systematický posun — a týká se KAŽDÉHO
 * drženého tónu, protože vibrato je v operním zpěvu pravidlo, ne výjimka.
 *
 * Mechanismus: SPR se dnes počítá z PRŮMĚRNÉHO spektra celého tónu. Vibrato
 * ale s harmonickými hýbe (o ±3 % = ±50 centů), takže se vrchol v pásmu 2–4 kHz
 * přes tón rozprostře a průměrováním se sníží. Čím víc se vrchol hýbe, tím
 * víc je číslo podhodnocené.
 *
 * Zkouší se šest způsobů, jak z toho ven — a rovnou se hlídá, že se nezkazí
 * případy, které dnes vycházejí dobře (čistý tón, doprovod, šum, krátký tón).
 */
import { ltas, spr } from '../src/analysis.js';

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
const sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); };
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))] : NaN; };

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
const sprI = (spec) => peakInterp(spec, 2000, 4000) - peakInterp(spec, 30, 2000);

/** SPR po rámcích → statistika. */
function perFrame(x, sr, stat, { nfft = 4096, hopDiv = 4 } = {}) {
  const step = Math.max(128, Math.round(nfft / hopDiv));
  const vals = [];
  for (let s = 0; s + nfft <= x.length; s += step) {
    const v = sprI(ltas(x.subarray(s, s + nfft), sr, nfft));
    if (v === v) vals.push(v);
  }
  if (!vals.length) return NaN;
  if (stat === 'median') return median(vals);
  if (stat === 'mean') return mean(vals);
  if (stat === 'p75') return pct(vals, 0.75);
  if (stat === 'p90') return pct(vals, 0.90);
  if (stat === 'max') return Math.max(...vals);
  if (stat === 'trimmean') {           // useknutý průměr 20 %
    const s = [...vals].sort((a, b) => a - b);
    const k = Math.floor(s.length * 0.2);
    return mean(s.slice(k, s.length - k || undefined));
  }
  return NaN;
}

/** Pravda (stejná jako v exp-accuracy-truth.mjs). */
function gain(f) {
  const res = (fc, bw, a) => a / (1 + ((f - fc) / bw) ** 2);
  return res(500, 120, 1.0) + res(1500, 180, 0.45) + res(2500, 220, 0.30)
       + res(3000, 250, 0.22) + res(3500, 300, 0.10);
}
function trueSPR(f0) {
  let lo = 0, hi = 0;
  for (let h = 1; h * f0 <= 4000; h++) {
    const f = h * f0, a = gain(f) / h ** 0.9;
    if (f < 2000) lo = Math.max(lo, a); else hi = Math.max(hi, a);
  }
  return (lo && hi) ? 20 * Math.log10(hi / lo) : NaN;
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function synth({ sr = 48000, dur = 1.0, f0 = 262, vibDepth = 0, vibRate = 5.5, accompHz = 0, accompDb = -18, noiseDb = -60, seed = 3 }) {
  const n = Math.round(sr * dur), rnd = mulberry32(seed), out = new Float64Array(n);
  const H = Math.floor(4000 / f0);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f0 * (1 + vibDepth * Math.sin(2 * Math.PI * vibRate * t));
    ph += 2 * Math.PI * f / sr;
    let v = 0;
    for (let h = 1; h <= H; h++) v += (gain(h * f0) / h ** 0.9) * Math.sin(h * ph);
    const env = Math.min(1, i / (sr * 0.05)) * Math.min(1, (n - i) / (sr * 0.10));
    out[i] = 0.3 * v * env;
  }
  if (accompHz) for (let i = 0; i < n; i++) out[i] += Math.pow(10, accompDb / 20) * Math.sin(2 * Math.PI * accompHz * i / sr);
  if (noiseDb > -90) { const na = Math.pow(10, (noiseDb - 3) / 20); for (let i = 0; i < n; i++) out[i] += (rnd() - 0.5) * 2 * na; }
  return out;
}

const MET = {
  'dnes (průměr spektra)':      (x, sr) => spr(ltas(x, sr, 4096)),
  'rámce: medián':             (x, sr) => perFrame(x, sr, 'median'),
  'rámce: useknutý průměr 20%': (x, sr) => perFrame(x, sr, 'trimmean'),
  'rámce: 75. percentil':      (x, sr) => perFrame(x, sr, 'p75'),
  'rámce: 90. percentil':      (x, sr) => perFrame(x, sr, 'p90'),
  'rámce: maximum':            (x, sr) => perFrame(x, sr, 'max'),
  'rámce: 75. pct, hop 2048':  (x, sr) => perFrame(x, sr, 'p75', { hopDiv: 2 }),
};
const CASES = {
  'A čistý':         { dur: 1.0 },
  'B vibrato 2 %':   { dur: 1.0, vibDepth: 0.02 },
  'B2 vibrato 3 %':  { dur: 1.0, vibDepth: 0.03 },
  'B3 vibrato 5 %':  { dur: 1.0, vibDepth: 0.05 },
  'C doprovod −18':  { dur: 1.0, accompHz: 880, accompDb: -18 },
  'D šum −30':       { dur: 1.0, noiseDb: -30 },
  'E krátký 0,45 s': { dur: 0.45 },
  'F vibrato+šum':   { dur: 1.0, vibDepth: 0.025, noiseDb: -30 },
};
const F0S = [196, 220, 247, 262, 294, 330, 349, 392, 440, 494];
const sr = 48000;
const names = Object.keys(MET);

console.log('PŘESNOST VŮČI ZNÁMÉ PRAVDĚ — medián |chyby| v dB (menší = lepší)');
console.log('u vibrata je vidět i SMĚR chyby (záporný = podhodnocuje)\n');
console.log('případ'.padEnd(18) + names.map(n => n.padStart(28)).join(''));
const totals = {};
for (const k of names) totals[k] = [];
for (const [cname, opt] of Object.entries(CASES)) {
  const cells = [];
  for (const k of names) {
    const errs = [];
    for (const f0 of F0S) {
      const x = synth({ sr, f0, ...opt });
      const got = MET[k](x, sr), truth = trueSPR(f0);
      if (got === got && truth === truth) errs.push(got - truth);
    }
    totals[k].push({ cname, abs: median(errs.map(Math.abs)), bias: mean(errs) });
    cells.push(('|ch| ' + median(errs.map(Math.abs)).toFixed(2) + '  ' + (mean(errs) >= 0 ? '+' : '') + mean(errs).toFixed(2)).padStart(28));
  }
  console.log(cname.padEnd(18) + cells.join(''));
}

console.log('\nSOUHRN: průměr |chyby| přes všechny případy (a nejhorší případ)');
for (const k of names) {
  const a = totals[k].map(t => t.abs);
  const worst = totals[k].reduce((w, t) => (t.abs > w.abs ? t : w), { abs: -1 });
  console.log('  ' + k.padEnd(28) + 'průměr ' + mean(a).toFixed(2) + ' dB   nejhorší ' + worst.cname + ' (' + worst.abs.toFixed(2) + ' dB)');
}

/* ── Je vítěz stabilní i na jiných f0 / délkách tónu? ──────────────────── */
console.log('\nSTABILITA: totéž na 40 jiných výškách (chromaticky 155–660 Hz), jen vibrato 3 %');
const many = [];
for (let f = 155; f <= 660; f *= Math.pow(2, 1 / 12)) many.push(Math.round(f * 10) / 10);
for (const k of names) {
  const errs = [];
  for (const f0 of many) {
    const x = synth({ sr, f0, dur: 1.0, vibDepth: 0.03 });
    const got = MET[k](x, sr), truth = trueSPR(f0);
    if (got === got && truth === truth) errs.push(Math.abs(got - truth));
  }
  console.log('  ' + k.padEnd(28) + 'medián |chyby| ' + median(errs).toFixed(2) + ' dB   90. pct ' + pct(errs, 0.90).toFixed(2) + ' dB   max ' + Math.max(...errs).toFixed(2));
}

/* ── Nezhorší se to na tónech, kde dnes chyba není? ────────────────────── */
console.log('\nHÁJENÍ: čistý tón + doprovod + šum dohromady (nesmí se to zkazit)');
for (const k of names) {
  const errs = [];
  for (const f0 of F0S) {
    for (const opt of [{ dur: 1.0 }, { dur: 1.0, accompHz: 880, accompDb: -18 }, { dur: 1.0, noiseDb: -30 }, { dur: 0.45 }]) {
      const x = synth({ sr, f0, ...opt });
      const got = MET[k](x, sr), truth = trueSPR(f0);
      if (got === got && truth === truth) errs.push(Math.abs(got - truth));
    }
  }
  console.log('  ' + k.padEnd(28) + 'medián |chyby| ' + median(errs).toFixed(2) + ' dB   max ' + Math.max(...errs).toFixed(2));
}
