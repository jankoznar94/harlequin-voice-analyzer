#!/usr/bin/env node
/**
 * EXPERIMENT: jak vyhladit časovou řadu SPR, aby se dala kreslit.
 *
 * Surová řada po rámcích je na reálném hlase velmi rozkmitaná (naměřeno
 * ~25 dB rozkmit uvnitř jednoho tónu) — kreslit ji syrovou by byl šum.
 * Na druhou stranu příliš silné vyhlazení schová právě to, kvůli čemu
 * graf vzniká: změnu ringu V PRŮBĚHU tónu.
 *
 * Měří se proti ZNÁMÉ PRAVDĚ: syntetický tón, u kterého se v polovině
 * záměrně změní jasnost (SPR). Hledá se vyhlazení, které:
 *   a) schod ukáže (rozdíl obou polovin zůstane),
 *   b) zbytečně nerozmaže hranici (přechodové okno),
 *   c) nekmítá (jitter mimo schod).
 *
 * Použití: node tools/exp-spr-vyhlazeni.mjs
 */
import { SprCore, percentile, SPR_NFFT } from '../src/analysis.js';

const SR = 48000;

function formantGain(f, bright) {
  // bright = 1 → normální vokál; bright = 0 → potlačené pásmo 2–4 kHz
  const F = [[700, 1.0, 110], [1220, 0.5, 130], [2600, bright * 0.35, 190]];
  let g = 0;
  for (const [fc, a, bw] of F) g += a / (1 + ((f - fc) / bw) ** 2);
  return Math.max(0.03, g);
}

/** Tón, jehož jasnost se v čase mění podle `bright(t)`. Fáze se integruje. */
function tone(n, f0, brightAt) {
  const out = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = f0;
    ph += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h * f < 5200; h++) v += formantGain(h * f, brightAt(i / SR)) * Math.sin(h * ph) / Math.sqrt(h);
    out[i] = 0.25 * v;
  }
  return out;
}

function rawSeries(x, hopDiv = 4, q = 0.5) {
  const nfft = SPR_NFFT;
  const step = Math.max(128, Math.round(nfft / hopDiv));
  const core = new SprCore(SR, nfft);
  const vals = [], ts = [];
  for (let s = 0; s + nfft <= x.length; s += step) {
    const core2 = core;
    const v = core2.of(x.subarray(s, s + nfft));
    if (v === v) { vals.push(v); ts.push(s / SR); }
  }
  return { vals, ts, step };
}

function ema(vals, a) {
  let e = NaN;
  return vals.map(v => (e = e !== e ? v : a * v + (1 - a) * e));
}
/** Klouzavý percentil přes k oknů — obdoba okna, ale percentil místo průměru. */
function slidingQ(vals, k, q) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const a = Math.max(0, i - k + 1), b = i + 1;
    out.push(percentile(vals.slice(a, b), q));
  }
  return out;
}

const N = Math.round(5 * SR);
const f0 = 220;
const T = 2.5;                              // změna v polovině
const x = tone(N, f0, (t) => (t < T ? 1 : 0.12));

const { vals, ts, step } = rawSeries(x);
const iMid = Math.round(T / (step / SR));
const half = (v) => ({ a: percentile(v.slice(0, iMid), 0.5), b: percentile(v.slice(iMid), 0.5) });
const spread = (v) => Math.max(...v) - Math.min(...v);
/** Kolik oknů od hranice má hodnota blíž k jedné nebo druhé polovině. */
function transitionFrames(v) {
  const { a, b } = half(v);
  let first = -1, last = -1;
  for (let i = 0; i < v.length; i++) {
    const near = Math.abs(v[i] - a) < Math.abs(v[i] - b) ? 'a' : 'b';
    if (near === 'b' && first < 0) first = i;
    if (near === 'b') last = i;
  }
  return { first, last, width: last - first + 1 };
}

const opts = [
  ['surová', vals],
  ['EMA α=0,35', ema(vals, 0.35)],
  ['EMA α=0,15', ema(vals, 0.15)],
  ['klouzavý p90 k=12 (0,25 s)', slidingQ(vals, 12, 0.9)],
  ['klouzavý p90 k=24 (0,5 s)', slidingQ(vals, 24, 0.9)],
  ['klouzavý medián k=12', slidingQ(vals, 12, 0.5)],
];

console.log(`\n=== známá pravda: tón ${f0} Hz, jasnost se v ${T} s změní ===`);
console.log(`rámců ${vals.length}, krok ${(step / SR * 1000).toFixed(1)} ms\n`);
console.log('vyhlazení                    pol.1    pol.2   schod   jitter(1.pol)  přechod  rozkmit');
for (const [name, v] of opts) {
  const { a, b } = half(v);
  const jit = spread(v.slice(Math.round(iMid * 0.3), Math.round(iMid * 0.9)));
  const tr = transitionFrames(v);
  console.log(`${name.padEnd(28)} ${a.toFixed(1).padStart(7)} ${b.toFixed(1).padStart(7)} ${(b - a).toFixed(1).padStart(7)}`
    + ` ${jit.toFixed(2).padStart(12)} ${String(tr.width).padStart(9)} ${spread(v).toFixed(1).padStart(9)}`);
}

/* Kontrolní případ: STABILNÍ tón — vyhlazení nesmí vyrobit schod, který tam není. */
console.log('\n=== kontrola: stabilní tón (schod NESMÍ vzniknout) ===');
const x2 = tone(N, f0, () => 1);
const r2 = rawSeries(x2);
console.log('vyhlazení                    pol.1    pol.2   „schod“  rozkmit');
for (const [name, f] of [['surová', (v, t) => v], ['EMA α=0,35', ema], ['klouzavý p90 k=12 (0,25 s)', (v) => slidingQ(v, 12, 0.9)], ['klouzavý p90 k=24 (0,5 s)', (v) => slidingQ(v, 24, 0.9)]]) {
  const v = f(r2.vals, 0.35);
  const { a, b } = half(v);
  console.log(`${name.padEnd(28)} ${a.toFixed(1).padStart(7)} ${b.toFixed(1).padStart(7)} ${(b - a).toFixed(1).padStart(8)} ${spread(v).toFixed(1).padStart(9)}`);
}
