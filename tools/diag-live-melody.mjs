#!/usr/bin/env node
/**
 * DIAGNOSTIKA: proč u vysoké melodie nesedí živá simulace s offline reportem?
 *
 * Podezření: klouzavé okno 0,6 s se přes krátké pauzy mezi tóny „míchá" a do
 * statistiky vstupují rámce z náběhu/doznívání, kde SPR ještě není ustálený.
 * Offline si naproti tomu bere 80 % VNITŘKU každého tónu a okraje vynechává.
 *
 * Vypíše se časový průběh, ať je vidět, kde hodnoty padají — hádat se nemá.
 *
 * Použití: node tools/diag-live-melody.mjs
 */
import { ltas, sprInterp, sprFrames, analyze } from '../src/analysis.js';

const SR = 48000;
const WIN = 4096;
const HOP = WIN / 4;

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

const f0s = [330, 349, 392, 440, 494, 523];
const sig = melody(f0s);

const res = analyze(sig, SR, { fach: 'tenor' });
console.log('\nOffline report: spr_novy_median =', res.summary.spr_novy_median?.toFixed(2));
console.log('Offline tóny:');
for (const n of res.notes) {
  console.log(`  ${n.note.padEnd(4)} t=${n.t_start.toFixed(2)}–${n.t_end.toFixed(2)} s  `
    + `dur ${n.dur.toFixed(2)}  spr ${Number.isFinite(n.spr) ? n.spr.toFixed(2) : '—'}  `
    + `spr_novy ${Number.isFinite(n.spr_novy) ? n.spr_novy.toFixed(2) : '—'}  `
    + `spl ${Number.isFinite(n.spl_dbfs) ? n.spl_dbfs.toFixed(1) : '—'}`);
}

// rozsah, kde offline bere vzorek (80 % vnitřku tónu) — odtud plynou hodnoty
console.log('\nRozsahy, ze kterých offline bere spektrum (80 % vnitřku):');
for (const n of res.notes) {
  const d = n.t_end - n.t_start;
  console.log(`  ${n.note.padEnd(4)} ${(n.t_start + 0.2 * d).toFixed(2)}–${(n.t_end - 0.2 * d).toFixed(2)} s`);
}

// živá simulace po rámcích
console.log('\nŽivá simulace (okno 4096, krok 21 ms) — SPR po rámcích:');
const rows = [];
for (let s = 0; s + WIN <= sig.length; s += HOP) {
  const seg = sig.subarray(s, s + WIN);
  let rms = 0;
  for (let i = 0; i < WIN; i++) rms += seg[i] * seg[i];
  rms = Math.sqrt(rms / WIN);
  const v = rms >= 0.010 ? sprInterp(ltas(seg, SR, WIN)) : NaN;
  rows.push({ t: s / SR, rms, v });
}
// tisk po 0,1 s
let line = '';
for (let i = 0; i < rows.length; i += 5) {
  const r = rows[i];
  line += `${r.t.toFixed(1)}:${Number.isFinite(r.v) ? r.v.toFixed(1) : '  ·'}  `;
  if ((i / 5) % 6 === 5) { console.log('  ' + line); line = ''; }
}
if (line) console.log('  ' + line);

const good = rows.filter(r => Number.isFinite(r.v));
console.log(`\nrámců se SPR: ${good.length} z ${rows.length}`);
console.log(`globální p90: ${pct(good.map(r => r.v), 0.90).toFixed(2)}`);
console.log(`medián:       ${median(good.map(r => r.v)).toFixed(2)}`);
console.log(`p90 v rámci tónu (jen vnitřky 80 %): `);
for (const n of res.notes) {
  const a = n.t_start + 0.2 * (n.t_end - n.t_start);
  const b = n.t_end - 0.2 * (n.t_end - n.t_start);
  const inside = good.filter(r => r.t >= a && r.t <= b).map(r => r.v);
  console.log(`  ${n.note.padEnd(4)} n=${String(inside.length).padStart(3)}  p90 ${inside.length ? pct(inside, 0.9).toFixed(2) : '—'}`
    + `   (offline spr_novy ${Number.isFinite(n.spr_novy) ? n.spr_novy.toFixed(2) : '—'})`);
}
