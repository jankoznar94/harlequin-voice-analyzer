#!/usr/bin/env node
/**
 * EXPERIMENT 3: rozhodující pokus — měřit SPR V ČASE místo z průměrného spektra.
 *
 * PROČ: předchozí experiment ukázal, že největší chyba SPR nevzniká metodou
 * (ta je přesná na 0,3 dB), ale VIBRATEM — s vibratem 3 % vychází SPR o 4,4 dB
 * níž. Mechanismus: doba, po kterou harmonická zůstane v pásmu 2–4 kHz, se
 * s vibratem rozprostře, průměrné spektrum vrchol rozmázne a vrchol se sníží.
 *
 * Dosavadní měření dělá PRŮMĚR spekter přes celý tón a teprve pak hledá vrchol.
 * Alternativa: spočítat SPR v KAŽDÉM rámci zvlášť a vzít MEDIÁN. Medián vrchol
 * nezměkčí (na rozdíl od průměru) a je odolný proti rámcům, kde se zrovna
 * nezpívá.
 *
 * Měří se dvě věci a obojí musí vyjít dobře:
 *  1) PŘESNOST vůči známé pravdě (syntetický tón s předepsanou strukturou).
 *  2) OPAKOVATELNOST na REÁLNÉM zpěvu — rozchod dvou polovin téhož tónu.
 *     Metoda, která je přesná na syntetice a nerozhodná na skutečném hlase,
 *     není oprava.
 */
import { readFileSync } from 'node:fs';
import { ltas, spr, analyze, spectralEnvelope } from '../src/analysis.js';

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
const sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); };

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

/** SPR z jednoho spektra s interpolovaným vrcholem. */
const sprI = (spec) => peakInterp(spec, 2000, 4000) - peakInterp(spec, 30, 2000);

/** MEDIÁN SPR přes rámce — jádro pokusu. */
function sprMedianFrames(x, sr, { nfft = 4096, hopDiv = 4 } = {}) {
  const step = Math.max(128, Math.round(nfft / hopDiv));
  const vals = [];
  for (let s = 0; s + nfft <= x.length; s += step) {
    const v = sprI(ltas(x.subarray(s, s + nfft), sr, nfft));
    if (v === v) vals.push(v);
  }
  return vals.length ? median(vals) : NaN;
}

/** PRAVDA pro syntetický tón (viz exp-accuracy-truth.mjs). */
function gain(f) {
  const res = (fc, bw, a) => a / (1 + ((f - fc) / bw) ** 2);
  return res(500, 120, 1.0) + res(1500, 180, 0.45) + res(2500, 220, 0.30)
       + res(3000, 250, 0.22) + res(3500, 300, 0.10);
}
function trueSPR(f0) {
  let lo = 0, hi = 0;
  for (let h = 1; h * f0 <= 4000; h++) {
    const f = h * f0, a = gain(f) / h ** 0.9;
    if (f < 2000) lo = Math.max(lo, a);
    else hi = Math.max(hi, a);
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
  'dnes: LTAS 4096':        (x, sr) => spr(ltas(x, sr, 4096)),
  'LTAS 4096 + interp':     (x, sr) => sprI(ltas(x, sr, 4096)),
  'medián rámců 4096':      (x, sr) => sprMedianFrames(x, sr, { nfft: 4096, hopDiv: 4 }),
  'medián rámců 8192':      (x, sr) => sprMedianFrames(x, sr, { nfft: 8192, hopDiv: 3 }),
  'medián rámců/2 (hop 2048)': (x, sr) => sprMedianFrames(x, sr, { nfft: 4096, hopDiv: 2 }),
};

const CASES = {
  'A čistý':          { dur: 1.0 },
  'B vibrato 3 %':    { dur: 1.0, vibDepth: 0.03 },
  'C doprovod −18':   { dur: 1.0, accompHz: 880, accompDb: -18 },
  'D šum −30':        { dur: 1.0, noiseDb: -30 },
  'E krátký 0,45 s':  { dur: 0.45 },
  'F vibrato+šum':    { dur: 1.0, vibDepth: 0.025, noiseDb: -30 },
};
const F0S = [196, 220, 247, 262, 294, 330, 349, 392, 440, 494];
const sr = 48000;
const names = Object.keys(MET);

console.log('=== 1) PŘESNOST VŮČI ZNÁMÉ PRAVDĚ (medián |chyby|, dB; menší = lepší) ===\n');
console.log('případ'.padEnd(18) + names.map(n => n.padStart(26)).join(''));
const summary = {};
for (const [cname, opt] of Object.entries(CASES)) {
  const cells = [];
  for (const k of names) {
    const errs = [];
    for (const f0 of F0S) {
      const x = synth({ sr, f0, ...opt });
      const got = MET[k](x, sr), truth = trueSPR(f0);
      if (got === got && truth === truth) errs.push(Math.abs(got - truth));
    }
    const m = median(errs);
    summary[`${cname}|${k}`] = m;
    cells.push(('|chyba| ' + m.toFixed(2) + '  SD ' + sd(errs).toFixed(2)).padStart(26));
  }
  console.log(cname.padEnd(18) + cells.join(''));
}

/* ── 2) REÁLNÝ ZPĚV: rozchod dvou polovin téhož tónu ────────────────────── */
const path = process.argv[2] || `${process.env.HOME}/.cache/vaud-test/zpev.wav`;
function loadWav(p) {
  const b = readFileSync(p);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = b.subarray(body, body + sz);
    off = body + sz + (sz & 1);
  }
  const N = Math.floor(data.length / (fmt.ch * fmt.bits / 8)), x = new Float64Array(N);
  for (let i = 0; i < N; i++) { let a = 0; for (let c = 0; c < fmt.ch; c++) a += data.readInt16LE((i * fmt.ch + c) * (fmt.bits / 8)) / 32768; x[i] = a / fmt.ch; }
  return { samples: x, sampleRate: fmt.sr };
}
const { samples, sampleRate } = loadWav(path);
const res = analyze(samples, sampleRate, { fach: 'tenor' });
const sp = res.notes.filter(n => n.spr === n.spr).map(n => n.spl_dbfs).sort((a, b) => a - b);
const splRef = sp[Math.min(sp.length - 1, Math.floor(0.75 * sp.length))];
const usable = res.notes.filter(n => n.spr === n.spr && n.dur >= 0.30 && n.spl_dbfs >= splRef - 20);

console.log(`\n=== 2) REÁLNÝ ZPĚV (${path.split('/').pop()}, ${usable.length} měřitelných tónů) ===`);
console.log('rozchod dvou POLOVIN téhož tónu — kolik dB metoda sama o sobě kolísá\n');
console.log('metoda'.padEnd(28) + 'rozchod   rozptyl mezi tóny   medián SPR');
for (const k of names) {
  const d = [], all = [];
  for (const n of usable) {
    const dur = n.t_end - n.t_start;
    const a = n.t_start + 0.20 * dur, b = n.t_end - 0.20 * dur;
    const i0 = Math.max(0, Math.floor(a * sampleRate)), i1 = Math.min(samples.length, Math.ceil(b * sampleRate));
    if (i1 - i0 < 4096) continue;
    const mid = (i0 + i1) >> 1;
    const v1 = MET[k](samples.subarray(i0, mid), sampleRate);
    const v2 = MET[k](samples.subarray(mid, i1), sampleRate);
    const vf = MET[k](samples.subarray(i0, i1), sampleRate);
    if (v1 === v1 && v2 === v2) d.push(Math.abs(v1 - v2));
    if (vf === vf) all.push(vf);
  }
  console.log(k.padEnd(28) + (mean(d).toFixed(2) + ' dB').padStart(8) + (sd(all).toFixed(2) + ' dB').padStart(18) + median(all).toFixed(2).padStart(14));
}

/* ── 3) hlídání: nepřepočítává se tím i něco jiného? ───────────────────── */
console.log('\n=== 3) KONTROLA: souhlas metod po tónech (r) ===');
const perNote = {};
for (const k of names) {
  perNote[k] = [];
  for (const n of usable) {
    const dur = n.t_end - n.t_start;
    const a = n.t_start + 0.20 * dur, b = n.t_end - 0.20 * dur;
    const i0 = Math.max(0, Math.floor(a * sampleRate)), i1 = Math.min(samples.length, Math.ceil(b * sampleRate));
    perNote[k].push(i1 - i0 >= 4096 ? MET[k](samples.subarray(i0, i1), sampleRate) : NaN);
  }
}
const corr = (A, B) => {
  const xs = [], ys = [];
  for (let i = 0; i < A.length; i++) if (A[i] === A[i] && B[i] === B[i]) { xs.push(A[i]); ys.push(B[i]); }
  const ma = mean(xs), mb = mean(ys);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - ma) * (ys[i] - mb); da += (xs[i] - ma) ** 2; db += (ys[i] - mb) ** 2; }
  return num / Math.sqrt(da * db || 1);
};
for (const k of names.slice(1)) console.log('  ' + names[0].padEnd(24) + 'vs ' + k.padEnd(28) + 'r = ' + corr(perNote[names[0]], perNote[k]).toFixed(3));
