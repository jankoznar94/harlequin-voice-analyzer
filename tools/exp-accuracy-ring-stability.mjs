#!/usr/bin/env node
/**
 * EXPERIMENT 8 (nejdůležitější): jak přesné je ČÍSLO, KTERÉ UŽIVATEL VIDÍ?
 *
 * Všechno ostatní bylo o SPR na jednom tónu. Jenže uživatel se rozhoduje podle
 * „ring 98 %". Testuje se proto PŘÍMO TO: tatáž nahrávka se rozdělí na dvě
 * poloviny (a na tři části) a změní se, kolik z toho vyjde.
 *
 * Když se dvě poloviny téhož zpěvu rozejdou o desítky procent, číslo není
 * přesné a je jedno, jak přesná je FFT. Když se rozejdou o jednotky procent,
 * hlavní zdroj nepřesnosti je jinde (v hodnotě SPR na tónu) a opravovat
 * segmentaci je slepá ulička.
 *
 * Zkouší se to na TŘECH variantách vyhodnocení, aby se vědělo, která je
 * nejstabilnější:
 *   A) dnešní: gapSplit přes SPR, filtr dur>=0.30 / spl
 *   B) po rámcích: SPR = horní percentil rámců (oprava vibrata z exp. 4)
 *   C) bez filtru podle hlasitosti (jen dur>=0.30)
 */
import { readFileSync } from 'node:fs';
import {
  analyze, ltas, spr, spectralEnvelope, ringAnalysis, medianFilter, countNotePlateaus, sprValid,
} from '../src/analysis.js';

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
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))] : NaN; };
function sprFrames(x, sr, { nfft = 4096, hopDiv = 4, q = 0.9 } = {}) {
  const step = Math.max(128, Math.round(nfft / hopDiv)), vals = [];
  for (let s = 0; s + nfft <= x.length; s += step) {
    const v = peakInterp(ltas(x.subarray(s, s + nfft), sr, nfft), 2000, 4000)
            - peakInterp(ltas(x.subarray(s, s + nfft), sr, nfft), 30, 2000);
    if (v === v) vals.push(v);
  }
  return vals.length ? pct(vals, q) : NaN;
}
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

/** Vyhodnotí ring z dodaných SPR hodnot (stejná logika jako ringAnalysis,
 *  aby se dalo měnit jen to, ODKUD SPR pochází). */
function ringFrom(notes, variant) {
  const list = notes.filter(n => n.spr === n.spr);
  if (!list.length) return { pct: NaN, n: 0, med: NaN, note: 'žádné' };
  let usable = list.filter(n => n.dur >= 0.30);
  if (variant !== 'C') {
    const spls = usable.map(n => n.spl_dbfs).sort((a, b) => a - b);
    const ref = spls.length ? spls[Math.min(spls.length - 1, Math.floor(0.75 * spls.length))] : NaN;
    const f = usable.filter(n => n.spl_dbfs >= ref - 20);
    if (f.length >= 0.4 * usable.length) usable = f;
  }
  if (!usable.length) return { pct: NaN, n: 0, med: NaN, note: 'po filtru nic' };
  const r = ringAnalysis(usable.map(n => ({ ...n })));
  const p = r.spr_unusable ? NaN : r.ring_consistency_pct;
  return { pct: (p === undefined || p === null) ? NaN : p, n: r.n_notes ?? usable.length, med: r.spr_median ?? NaN, note: r.reason || '' };
}

const FILES = [
  `${process.env.HOME}/.cache/vaud-test/zpev.wav`,
  `${process.env.HOME}/.cache/vaud-test/zpev_s_doprovodem.wav`,
  `${process.env.HOME}/.cache/vaud-test/zpev3x.wav`,
];

for (const f of FILES) {
  let L;
  try { L = loadWav(f); } catch { continue; }
  const name = f.split('/').pop();
  const cuts = [
    ['celá', 0, 1], ['první polovina', 0, 0.5], ['druhá polovina', 0.5, 1],
    ['první třetina', 0, 1 / 3], ['prostřední třetina', 1 / 3, 2 / 3], ['poslední třetina', 2 / 3, 1],
  ];
  console.log(`\n===== ${name} (${(L.samples.length / L.sampleRate).toFixed(0)} s) =====`);
  console.log('část'.padEnd(20) + 'dnešní SPR → ring'.padEnd(26) + 'rámce p90 → ring'.padEnd(26) + 'bez filtru hl. → ring');
  const acc = { A: [], B: [], C: [] };
  for (const [label, a, b] of cuts) {
    const seg = L.samples.subarray(Math.floor(a * L.samples.length), Math.floor(b * L.samples.length));
    const res = analyze(seg, L.sampleRate, { fach: 'tenor' });
    // varianta B: přepočítat SPR po rámcích na týchž tónech
    const notesB = res.notes.map((n) => {
      const dur = n.t_end - n.t_start;
      const s0 = n.t_start + 0.20 * dur, s1 = n.t_end - 0.20 * dur;
      const i0 = Math.max(0, Math.floor(s0 * L.sampleRate)), i1 = Math.min(seg.length, Math.ceil(s1 * L.sampleRate));
      if (i1 - i0 < 4096) return { ...n, spr: NaN };
      return { ...n, spr: sprFrames(seg.subarray(i0, i1), L.sampleRate) };
    });
    const A = ringFrom(res.notes, 'A');
    const B = ringFrom(notesB, 'B');
    const C = ringFrom(res.notes, 'C');
    acc.A.push(A.pct); acc.B.push(B.pct); acc.C.push(C.pct);
    const fmt = (r) => (`${r.pct === r.pct ? r.pct.toFixed(1) + ' %' : '—'} (${r.n} tónů, SPR ${r.med === r.med ? r.med.toFixed(1) : '—'})`).padEnd(26);
    console.log(label.padEnd(20) + fmt(A) + fmt(B) + fmt(C));
  }
  const halves = (v) => Math.abs(v[1] - v[2]);
  const thirds = (v) => [v[3], v[4], v[5]].filter(x => x === x);
  console.log('  ROZCHOD polovin (hlavní otázka):  dnešní ' + halves(acc.A).toFixed(1) + ' %   rámce p90 ' + halves(acc.B).toFixed(1) + ' %   bez filtru ' + halves(acc.C).toFixed(1) + ' %');
  console.log('  rozptyl tří třetin            :  dnešní ' + sd(thirds(acc.A)).toFixed(1) + ' %   rámce p90 ' + sd(thirds(acc.B)).toFixed(1) + ' %   bez filtru ' + sd(thirds(acc.C)).toFixed(1) + ' %');
}
