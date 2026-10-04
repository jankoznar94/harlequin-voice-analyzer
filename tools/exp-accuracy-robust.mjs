#!/usr/bin/env node
/**
 * EXPERIMENT 5: HÁJENÍ VÍTĚZE. Nové měření (SPR po rámcích → horní percentil)
 * musí obstát tam, kde by mohlo ublížit:
 *
 *  1) TRANZIENTY. Nahrávka obsahuje souhlásky, šramot, náraz do mikrofonu.
 *     Percentil bere „nejlepší" rámce, takže by mohl ulovit PRÁSK a vyrobit
 *     falešný ring. Testuje se: tón + klik, tón + sykavka, tón + doprovod.
 *  2) TÓNY S VÝPADKEM. Když tón ring skutečně NEMÁ, nesmí ho metoda „najít"
 *     v pár dobrých rámcích. Testuje se tón, kterému je pásmo 2–4 kHz opravdu
 *     utopené (model nezpěváka podle Omoriho).
 *  3) REÁLNÉ NAHRÁVKY. Co to udělá se SPR, rozptylem a ringem na skutečném
 *     zpěvu — včetně nahrávky, kde je pásmo 2–4 kHz potlačené.
 *
 * Bez bodu 1 a 2 by to byla změna, která „vylepší" čísla tam, kde se to hodí,
 * a zkazí je tam, kde na tom záleží.
 */
import { readFileSync } from 'node:fs';
import { ltas, spr, analyze } from '../src/analysis.js';

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

function perFrame(x, sr, stat, { nfft = 4096, hopDiv = 4 } = {}) {
  const step = Math.max(128, Math.round(nfft / hopDiv));
  const vals = [];
  for (let s = 0; s + nfft <= x.length; s += step) {
    const v = sprI(ltas(x.subarray(s, s + nfft), sr, nfft));
    if (v === v) vals.push(v);
  }
  if (!vals.length) return NaN;
  if (stat === 'median') return median(vals);
  if (stat === 'p75') return pct(vals, 0.75);
  if (stat === 'p90') return pct(vals, 0.90);
  if (stat === 'max') return Math.max(...vals);
  if (stat === 'p95') return pct(vals, 0.95);
  return NaN;
}
const MET = {
  'dnes':        (x, sr) => spr(ltas(x, sr, 4096)),
  'rámce medián': (x, sr) => perFrame(x, sr, 'median'),
  'rámce p75':   (x, sr) => perFrame(x, sr, 'p75'),
  'rámce p90':   (x, sr) => perFrame(x, sr, 'p90'),
  'rámce max':   (x, sr) => perFrame(x, sr, 'max'),
};

/* ── syntetika ─────────────────────────────────────────────────────────── */
/** Obálka hlasu. `formantCl` = síla shluku zpěváckého formantu (0 = bez ringu). */
function mkGain(cluster) {
  return (f) => {
    const res = (fc, bw, a) => a / (1 + ((f - fc) / bw) ** 2);
    return res(500, 120, 1.0) + res(1500, 180, 0.45)
         + cluster * (res(2500, 220, 0.30) + res(3000, 250, 0.22) + res(3500, 300, 0.10));
  };
}
function trueSPR(f0, cluster = 1) {
  const g = mkGain(cluster);
  let lo = 0, hi = 0;
  for (let h = 1; h * f0 <= 4000; h++) {
    const f = h * f0, a = g(f) / h ** 0.9;
    if (f < 2000) lo = Math.max(lo, a); else hi = Math.max(hi, a);
  }
  return (lo && hi) ? 20 * Math.log10(hi / lo) : NaN;
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function synth({ sr = 48000, dur = 1.0, f0 = 262, vibDepth = 0.03, cluster = 1, noiseDb = -60,
                 clickAt = 0, clickDb = -6, sibAt = 0, sibDb = -12, accompHz = 0, accompDb = -18, seed = 3, hpFilter = false }) {
  const n = Math.round(sr * dur), rnd = mulberry32(seed), out = new Float64Array(n);
  const g = mkGain(cluster), H = Math.max(3, Math.floor(4000 / f0));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f0 * (1 + vibDepth * Math.sin(2 * Math.PI * 5.5 * t));
    ph += 2 * Math.PI * f / sr;
    let v = 0;
    for (let h = 1; h <= H; h++) v += (g(h * f0) / h ** 0.9) * Math.sin(h * ph);
    const env = Math.min(1, i / (sr * 0.05)) * Math.min(1, (n - i) / (sr * 0.10));
    out[i] = 0.3 * v * env;
  }
  if (accompHz) for (let i = 0; i < n; i++) out[i] += Math.pow(10, accompDb / 20) * Math.sin(2 * Math.PI * accompHz * i / sr);
  if (clickAt) {                    // náraz do mikrofonu: jeden vzorek + doznění
    const i0 = Math.round(clickAt * sr), a = Math.pow(10, clickDb / 20);
    for (let k = 0; k < 240 && i0 + k < n; k++) out[i0 + k] += a * Math.exp(-k / 25) * (rnd() * 2 - 1);
  }
  if (sibAt) {                      // sykavka: úzkopásmový šum 5–9 kHz
    const i0 = Math.round(sibAt * sr), a = Math.pow(10, sibDb / 20);
    let p1 = 0, p2 = 0;
    for (let k = 0; k < 2400 && i0 + k < n; k++) { p1 += 0.3 * rnd(); p2 = 0.98 * p2 + 0.02 * p1; out[i0 + k] += a * (p1 - p2) * 4; }
  }
  if (noiseDb > -90) { const na = Math.pow(10, (noiseDb - 3) / 20); for (let i = 0; i < n; i++) out[i] += (rnd() - 0.5) * 2 * na; }
  if (hpFilter) {                   // model telefonu / nezpěváka: pásmo 2–4 kHz utopené
    const fc = 2200, b = 2 * Math.PI * fc / sr, al = b / (1 + b);
    let y = 0;
    for (let i = 0; i < n; i++) { y += al * (out[i] - y); out[i] = out[i] - y; }
  }
  return out;
}

const F0S = [196, 220, 247, 262, 294, 330, 349, 392, 440, 494];
const sr = 48000;
const names = Object.keys(MET);
const line = (label, opt, truthFn) => {
  const cells = [];
  for (const k of names) {
    const errs = [];
    for (const f0 of F0S) {
      const x = synth({ sr, f0, ...opt });
      const got = MET[k](x, sr), truth = truthFn(f0);
      if (got === got && truth === truth) errs.push(got - truth);
    }
    cells.push((mean(errs) >= 0 ? '+' : '') + mean(errs).toFixed(2) + ' ±' + sd(errs).toFixed(2));
  }
  console.log(label.padEnd(30) + cells.map(c => c.padStart(13)).join(''));
};

console.log('=== 1) ROZBITÍ TRANZIENTY (chyba proti pravdě, dB) ===');
console.log('případ'.padEnd(30) + names.map(n => n.padStart(13)).join(''));
line('čistý + vibrato 3 %', { dur: 1.0 }, trueSPR);
line('+ náraz do mikrofonu', { dur: 1.0, clickAt: 0.5, clickDb: -6 }, trueSPR);
line('+ silný náraz −0 dB', { dur: 1.0, clickAt: 0.5, clickDb: 0 }, trueSPR);
line('+ sykavka', { dur: 1.0, sibAt: 0.5, sibDb: -12 }, trueSPR);
line('+ doprovod 880 −18', { dur: 1.0, accompHz: 880, accompDb: -18 }, trueSPR);
line('bez vibrata, čistý', { dur: 1.0, vibDepth: 0 }, trueSPR);

console.log('\n=== 2) FALEŠNÝ RING: tón, který ring NEMÁ (shluk formantu 0,25×) ===');
console.log('(pravda je −8 až −10 dB; metoda, která ukáže víc, si ring vymýšlí)');
console.log('případ'.padEnd(30) + names.map(n => n.padStart(13)).join(''));
for (const cl of [0.0, 0.25, 0.5, 1.0]) {
  const cells = [];
  const truth = F0S.map(f => trueSPR(f, cl));
  for (const k of names) {
    const vals = F0S.map(f => MET[k](synth({ sr, f0: f, dur: 1.0, cluster: cl }), sr));
    cells.push(('změřeno ' + median(vals).toFixed(1) + ' / pravda ' + median(truth).toFixed(1)).padStart(13));
  }
  console.log(('shluk ' + cl).padEnd(30) + cells.join(''));
}
console.log('\n(poslední sloupec nic neříká o přesnosti, jen o posunu — rozhoduje,');
console.log(' jestli metoda hlásí VÍC ringu tam, kde žádný není)');

console.log('\n=== 3) MODEL NEZPĚVÁKA (pásmo 2–4 kHz utopené horní propustí) ===');
console.log('případ'.padEnd(30) + names.map(n => n.padStart(13)).join(''));
line('čistý + vibrato 3 %', { dur: 1.0 }, trueSPR);
line('utopené pásmo + vibrato', { dur: 1.0, hpFilter: true }, trueSPR);

/* ── 4) REÁLNÉ NAHRÁVKY ────────────────────────────────────────────────── */
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

const FILES = process.argv.slice(2).length ? process.argv.slice(2) : [
  `${process.env.HOME}/.cache/vaud-test/zpev.wav`,
  `${process.env.HOME}/.cache/vaud-test/zpev_s_doprovodem.wav`,
  `${process.env.HOME}/.cache/vaud-test/potichu.wav`,
  `${process.env.HOME}/.cache/vaud-test/caruso-amor.wav`,
];
console.log('\n=== 4) REÁLNÉ NAHRÁVKY: rozchod dvou polovin téhož tónu a posun čísla ===');
for (const f of FILES) {
  let L;
  try { L = loadWav(f); } catch { console.log('  (přeskočeno: ' + f + ')'); continue; }
  const res = analyze(L.samples, L.sampleRate, { fach: 'tenor' });
  const sp = res.notes.filter(n => n.spr === n.spr).map(n => n.spl_dbfs).sort((a, b) => a - b);
  const splRef = sp.length ? sp[Math.min(sp.length - 1, Math.floor(0.75 * sp.length))] : NaN;
  const usable = res.notes.filter(n => n.spr === n.spr && n.dur >= 0.30 && n.spl_dbfs >= splRef - 20);
  console.log(`\n  ${f.split('/').pop()}  (${res.n_notes} tónů, ${usable.length} měřitelných, medián hlasitosti ${median(usable.map(n => n.spl_dbfs)).toFixed(1)} dBFS)`);
  console.log('    ' + 'metoda'.padEnd(14) + 'SPR medián   rozptyl   rozchod polovin');
  for (const k of names) {
    const all = [], dd = [];
    for (const n of usable) {
      const dur = n.t_end - n.t_start;
      const a = n.t_start + 0.20 * dur, b = n.t_end - 0.20 * dur;
      const i0 = Math.max(0, Math.floor(a * L.sampleRate)), i1 = Math.min(L.samples.length, Math.ceil(b * L.sampleRate));
      if (i1 - i0 < 4096) continue;
      const mid = (i0 + i1) >> 1;
      const vf = MET[k](L.samples.subarray(i0, i1), L.sampleRate);
      const v1 = MET[k](L.samples.subarray(i0, mid), L.sampleRate);
      const v2 = MET[k](L.samples.subarray(mid, i1), L.sampleRate);
      if (vf === vf) all.push(vf);
      if (v1 === v1 && v2 === v2) dd.push(Math.abs(v1 - v2));
    }
    console.log('    ' + k.padEnd(14) + median(all).toFixed(2).padStart(9) + sd(all).toFixed(2).padStart(11) + mean(dd).toFixed(2).padStart(15));
  }
}
