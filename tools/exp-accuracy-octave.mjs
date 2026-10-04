#!/usr/bin/env node
/**
 * Kolik tónů se ztratí BEZ vibrata a S vibratem — oktávová chyba YIN je
 * vázaná na to, že se harmonická trefí přesně do formantu. Vibrato s tím hýbe,
 * takže se dá čekat, že chyba mizí. Ověřit, ne hádat.
 */
import { ltas, yinFrame, pitchTrack, medianFilter, countNotePlateaus, hzToNote, REFS } from '../src/analysis.js';

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function voice({ sr = 48000, dur = 1.2, f0 = 262, formants, vib = 0.02, seed = 5 }) {
  const n = Math.round(sr * dur), out = new Float64Array(n), rnd = mulberry32(seed);
  const g = (f) => formants.reduce((s, [fc, bw, a]) => s + a / (1 + ((f - fc) / bw) ** 2), 0);
  const H = Math.floor(5000 / f0);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f0 * (1 + vib * Math.sin(2 * Math.PI * 5.5 * t));
    ph += 2 * Math.PI * f / sr;
    let v = 0;
    for (let h = 1; h <= H; h++) v += (g(h * f0) / h ** 0.8) * Math.sin(h * ph);
    const env = Math.min(1, i / (sr * 0.08)) * Math.min(1, (n - i) / (sr * 0.15));
    out[i] = 0.3 * v * env + (rnd() - 0.5) * 2e-5;
  }
  return out;
}
const VOWELS = {
  '/a/': [[700, 110, 1.0], [1200, 150, 0.5], [2600, 250, 0.35]],
  '/e/': [[500, 100, 1.0], [1800, 160, 0.45], [2500, 250, 0.35]],
  '/i/': [[300, 90, 1.0], [2200, 180, 0.45], [2900, 260, 0.30]],
  '/o/': [[450, 100, 1.0], [800, 140, 0.6], [2500, 250, 0.35]],
  '/u/': [[320, 90, 1.0], [700, 130, 0.5], [2400, 240, 0.30]],
};
const F0S = [];
for (let f = 131; f <= 700; f *= Math.pow(2, 1 / 12)) F0S.push(Math.round(f * 10) / 10);
const sr = 48000;
const [loT, hiT] = REFS.fach_ranges.tenor;

for (const vib of [0, 0.005, 0.02, 0.04]) {
  let n = 0, lost = 0, octErrs = 0, octN = 0;
  const lostNotes = [];
  for (const f0 of F0S) {
    for (const [vn, form] of Object.entries(VOWELS)) {
      const x = voice({ sr, f0, formants: form, vib });
      const pt = pitchTrack(x, sr, {});
      const sm = medianFilter(pt.f0, 15);
      const pl = countNotePlateaus(pt.times, sm, { minDur: 0.22 });
      n += pl.length;
      for (const p of pl) {
        const med = p.f0;
        if (!(med > 0) || med < loT || med > hiT || (p.t1 - p.t0) > 12) { lost++; lostNotes.push(`${hzToNote(f0)}${vn}→${hzToNote(med)}`); }
      }
      // kolik RÁMCŮ má oktávovou chybu
      for (let i = 0; i < pt.f0.length; i++) {
        if (pt.f0[i] > 0) { octN++; if (pt.f0[i] > f0 * 1.7) octErrs++; }
      }
    }
  }
  console.log(`vibrato ${(vib * 100).toFixed(1).padStart(4)} %  →  nalezeno ${n} tónů, VYHOZENO ${lost} (${(100 * lost / (n || 1)).toFixed(1)} %),  rámců s dvojnásobnou výškou ${octErrs}/${octN} (${(100 * octErrs / (octN || 1)).toFixed(2)} %)`);
  if (lostNotes.length) console.log('    ' + lostNotes.slice(0, 14).join('  ') + (lostNotes.length > 14 ? ' …' : ''));
}
