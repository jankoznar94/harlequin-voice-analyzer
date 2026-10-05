#!/usr/bin/env node
/**
 * Reprodukce: proč NÍZKÉ tóny propadnou na „V nahrávce nejsou žádné zpívané tóny".
 *
 * Zkouší tři nezávislé mechanizmy na syntetickém drženém tónu s formantovou
 * obálkou (stejná metoda jako exp-octave-notes.mjs):
 *   A) čistý dlouhý tón bez doprovodu, 0,5–5 s
 *   B) totéž + tón doprovodu (klavír) pod hlasem
 *   C) totéž + ticho na začátku a na konci (jako když člověk nahraje tón mezi pauzy)
 *
 * Výstup: pro každý případ počet nalezených tónů a co hlásí band/spr.
 */
import { analyze } from '../src/analysis.js';

const SR = 48000;
function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function ampAt(f, F) { let a = 0; for (const [fc, bw, g] of F) a += g / (1 + Math.pow((f - fc) / bw, 2)); return a + 0.02; }

/** Držený tón s formantovou obálkou; fáze se INTEGRUJE (fázové skoky kazí YIN). */
function tone(f0, dur, F, { amp = 0.28, vib = 0.02, seed = 5 } = {}) {
  const n = Math.round(SR * dur), o = new Float64Array(n), r = rng(seed);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const inst = f0 * (1 + vib * Math.sin(2 * Math.PI * 5.6 * i / SR));
    ph += 2 * Math.PI * inst / SR;
    let v = 0;
    for (let h = 1; h * inst < 5000; h++) v += ampAt(h * inst, F) * Math.sin(h * ph) / Math.sqrt(h);
    o[i] = amp * v + (r() - 0.5) * 3e-4;
  }
  return o;
}
/** Jednoduchý „klavír": silná základní + harmonické, doznívání. */
function piano(f0, dur, amp) {
  const n = Math.round(SR * dur), o = new Float64Array(n);
  for (let h = 1; h <= 8; h++) {
    const a = amp * Math.pow(0.6, h - 1);
    for (let i = 0; i < n; i++) {
      const env = Math.exp(-1.2 * i / SR);
      o[i] += a * env * Math.sin(2 * Math.PI * f0 * h * i / SR);
    }
  }
  return o;
}
function mix(...parts) {
  const n = Math.max(...parts.map(p => p.length));
  const o = new Float64Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) o[i] += p[i];
  return o;
}
function silence(dur) { return new Float64Array(Math.round(SR * dur)); }

/** Vokál /a/ — F1 700, F2 1200, F3 2600 (mužský hlas). */
const A = [[700, 90, 1], [1200, 120, 0.55], [2600, 180, 0.35]];

function run(label, samples, fach = 'tenor') {
  const res = analyze(samples.length > 0 ? samples : new Float64Array(SR), SR, { fach, progress: () => {} });
  const kept = res.notes.length;
  const dropped = (res.dropped || []).map(d => d.why);
  const from = {};
  for (const w of dropped) { const k = w.split(' ')[0] + (w.includes('mimo') ? ' mimo obor' : ''); from[k] = (from[k] || 0) + 1; }
  const spr = res.summary?.sprMedian;
  console.log(`${label.padEnd(44)} tónů ${String(kept).padStart(2)} | vyřazeno ${String(dropped.length).padStart(2)} ${JSON.stringify(from)} | pásmo ${res.band?.limit?.toFixed(0) ?? '—'} Hz valid=${res.band?.valid} | peak ${res.peak_dbfs.toFixed(1)} dBFS | SPR ${Number.isFinite(spr) ? spr.toFixed(1) : '—'} | unusable=${!!res.summary?.spr_unusable}`);
}

console.log('=== A) čistý držený tón, měnící se délka (vokál /a/, tón D3 = 146,8 Hz)');
for (const d of [0.5, 1.0, 1.5, 2.0, 3.0, 5.0]) run(`A D3 ${d} s`, tone(146.83, d, A));

console.log('\n=== A2) čistý držený tón, různé nízké výšky (2 s)');
for (const [f, name] of [[82.41, 'E2'], [98.0, 'G2'], [123.47, 'B2'], [130.81, 'C3'], [146.83, 'D3'], [164.81, 'E3'], [196.0, 'G3'], [220.0, 'A3'], [261.63, 'C4'], [329.63, 'E4']]) {
  run(`A2 ${name} ${f} Hz 2 s`, tone(f, 2.0, A));
}

console.log('\n=== B) totéž s tónem doprovodu pod hlasem (klavír −15 dB)');
for (const [f, name] of [[98.0, 'G2'], [130.81, 'C3'], [146.83, 'D3'], [196.0, 'G3'], [261.63, 'C4']]) {
  const v = tone(f, 2.0, A);
  const p = piano(f * 0.5, 2.0, 0.28 * Math.pow(10, -15 / 20));
  run(`B ${name} ${f} Hz + klavír −15 dB`, mix(v, p));
}

console.log('\n=== C) tón mezi tichem (0,5 s ticho | 2 s tón | 0,5 s ticho)');
for (const [f, name] of [[98.0, 'G2'], [130.81, 'C3'], [146.83, 'D3'], [196.0, 'G3'], [261.63, 'C4']]) {
  run(`C ${name} ${f} Hz`, mix(silence(0.5), tone(f, 2.0, A), silence(0.5)));
}
