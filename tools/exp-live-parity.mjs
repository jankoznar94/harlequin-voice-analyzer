#!/usr/bin/env node
/**
 * EXPERIMENT: která živá statistika odpovídá offline `spr_novy_median`?
 *
 * Offline metrika je: pro KAŽDÝ TÓN p90 přes rámce okna 4096, a z těch tónů
 * MEDIÁN. Živý režim tóny nezná (nesegmentuje), takže se hledá nejbližší
 * analogie: p90 přes krátké klouzavé okno (to je „jeden tón") a z těch hodnot
 * MEDIÁN přes celé měření. Tady se měří, jak velký je rozdíl proti reportu.
 *
 * Použití: node tools/exp-live-parity.mjs
 */
import { ltas, sprInterp, sprFrames, analyze } from '../src/analysis.js';

const SR = 48000;
const WIN = 4096;
const HOP = WIN / 4;        // 1024 — přesně krok `sprFrames` (hopDiv 4)

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))] : NaN; };

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function tone(f0, dur, { vibDepth = 0, vibRate = 5.5, seed = 5 } = {}) {
  const n = Math.round(SR * dur);
  const out = new Float64Array(n);
  const rnd = mulberry32(seed);
  const formants = [[700, 80, 1.0], [1200, 110, 0.55], [2600, 180, 0.35]];
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 * (1 + vibDepth * Math.sin(2 * Math.PI * vibRate * t));
    phase += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h * f0 < 5200; h++) {
      const fr = h * f0;
      let amp = 0;
      for (const [fc, bw, g] of formants) amp += g / (1 + Math.pow((fr - fc) / bw, 2));
      amp += 0.02;
      v += amp * Math.sin(phase * h) / Math.sqrt(h);
    }
    const env = Math.min(1, i / (SR * 0.05)) * Math.min(1, (n - i) / (SR * 0.10));
    out[i] = 0.28 * v * env + (rnd() - 0.5) * 3e-4;
  }
  return out;
}

function melody(f0s, dur = 1.4) {
  const parts = [];
  for (let i = 0; i < f0s.length; i++) {
    parts.push(tone(f0s[i], dur, { vibDepth: 0.025, seed: 5 + i }));
    parts.push(new Float64Array(Math.round(SR * 0.25)));
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float64Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * Živá cesta: klouzavé okno 4096 s krokem 1024, SPR s interpolovaným vrcholem.
 * Vrací:
 *   globalP90     — p90 ze VŠECH rámců
 *   medRollP90    — medián přes klouzavá okna z p90 uvnitř okna  (kandidát)
 *   medRollMedian — medián přes klouzavá okna z mediánu uvnitř okna
 */
function liveFixed(x, { rollSec = 0.6 } = {}) {
  const vals = [];
  const maxRoll = Math.max(3, Math.round(rollSec * SR / HOP));
  const roll = [];
  const rollP90 = [];
  for (let s = 0; s + WIN <= x.length; s += HOP) {
    const seg = x.subarray(s, s + WIN);
    let rms = 0;
    for (let i = 0; i < WIN; i++) rms += seg[i] * seg[i];
    if (Math.sqrt(rms / WIN) < 0.010) continue;         // stejná brána jako živě
    const v = sprInterp(ltas(seg, SR, WIN));
    if (v !== v) continue;
    vals.push(v);
    roll.push(v);
    if (roll.length > maxRoll) roll.shift();
    rollP90.push(pct(roll, 0.90));
  }
  return {
    n: vals.length,
    globalP90: pct(vals, 0.90),
    medRollP90: median(rollP90),
    medRollMedian: median(roll.map((_, i) => i)),  // placeholder, dopočítá se níž
    rollP90,
  };
}

/** Totéž, ale medián uvnitř okna (druhá varianta). */
function liveRollMedian(x, { rollSec = 0.6 } = {}) {
  const maxRoll = Math.max(3, Math.round(rollSec * SR / HOP));
  const roll = [];
  const out = [];
  for (let s = 0; s + WIN <= x.length; s += HOP) {
    const seg = x.subarray(s, s + WIN);
    let rms = 0;
    for (let i = 0; i < WIN; i++) rms += seg[i] * seg[i];
    if (Math.sqrt(rms / WIN) < 0.010) continue;
    const v = sprInterp(ltas(seg, SR, WIN));
    if (v !== v) continue;
    roll.push(v);
    if (roll.length > maxRoll) roll.shift();
    out.push(median(roll));
  }
  return median(out);
}

const cases = [
  ['držený 247, vibrato 3 %', tone(247, 6, { vibDepth: 0.03 })],
  ['držený 330, vibrato 3 %', tone(330, 6, { vibDepth: 0.03 })],
  ['držený 392, vibrato 3 %', tone(392, 6, { vibDepth: 0.03 })],
  ['držený 440, vibrato 3 %', tone(440, 6, { vibDepth: 0.03 })],
  ['držený 440, čistý', tone(440, 6)],
  ['melodie 6 tónů', melody([196, 220, 247, 262, 294, 330])],
  ['melodie vysoká', melody([330, 349, 392, 440, 494, 523])],
  ['melodie krátkých 0,4 s', melody([294, 330, 349, 392, 440, 494], 0.4)],
];

console.log('\nOFFLINE spr_novy_median  vs  živé varianty (cíl: rozdíl do ~1 dB)\n');
console.log('případ'.padEnd(26) + 'OFF p90'.padStart(9) + 'živě glob'.padStart(11)
  + 'živě med(p90/0,6s)'.padStart(19) + 'živě med(med/0,6s)'.padStart(19) + 'Δ'.padStart(8));

const diffs = [];
for (const [label, sig] of cases) {
  const res = analyze(sig, SR, { fach: 'tenor' });
  const off = res.summary.spr_novy_median;
  const a = liveFixed(sig);
  const b = liveRollMedian(sig);
  const d = a.medRollP90 - off;
  diffs.push(Math.abs(d));
  console.log(`${label.padEnd(26)}`
    + `${Number.isFinite(off) ? off.toFixed(2).padStart(9) : '—'.padStart(9)}`
    + `${a.globalP90.toFixed(2).padStart(11)}`
    + `${a.medRollP90.toFixed(2).padStart(19)}`
    + `${b.toFixed(2).padStart(19)}`
    + `${d.toFixed(2).padStart(8)}`);
}

console.log(`\nmedián |rozdílu| proti offline reportu: ${median(diffs).toFixed(2)} dB, maximum ${Math.max(...diffs).toFixed(2)} dB`);

/* ── okno 0,6 s vs jiné délky ────────────────────────────────────────────── */

console.log('\nVOLBA DÉLKY KLOUZAVÉHO OKNA (medián z p90 uvnitř okna, vše proti offline)\n');
console.log('případ'.padEnd(26) + [0.3, 0.5, 0.6, 0.8, 1.2, 2.0].map(s => `${s}s`.padStart(8)).join(''));

for (const [label, sig] of cases) {
  const res = analyze(sig, SR, { fach: 'tenor' });
  const off = res.summary.spr_novy_median;
  const cells = [0.3, 0.5, 0.6, 0.8, 1.2, 2.0].map(sec => {
    const v = liveRollMedian(sig, {}) ;  // dopočítá se přes liveFixed podle rollSec
    const lf = liveFixed(sig, { rollSec: sec });
    return (lf.medRollP90 - off).toFixed(2).padStart(8);
  });
  console.log(`${label.padEnd(26)}${cells.join('')}`);
}

console.log('\nHotovo.');
