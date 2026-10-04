#!/usr/bin/env node
/**
 * DIAGNOSTIKA: živé okno vs `sprFrames` na TÉMŽE signálu — hodnota po hodnotě.
 *
 * Napoprvé vyšly dvě měření „živého" čísla rozdílně (−2,38 a −1,64), což
 * znamená, že jeden z těch pokusů neměřil totéž. Hádat se nemá — porovnají se
 * okna jeden na jednoho: kdyby se hodnoty lišily, je chyba v jádře; kdyby se
 * lišily jen STATISTIKY nad stejnými hodnotami, je chyba ve srovnávání.
 *
 * Použití: node tools/diag-live-vs-sprframes.mjs
 */
import path from 'node:path';
import { sprFrames, percentile, SprCore } from '../src/analysis.js';
import { createLiveState, feedFrame, BLOCK_MS, FRAME_SIZE } from '../src/live.js';
import { createDsp } from '../src/dsp-backend.js';

const WASM = path.join(import.meta.dirname, '..', 'wasm', 'build', 'dsp.wasm');
const SR = 48000, HOP = Math.round(SR * BLOCK_MS / 1000);
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const gainOf = (f) => {
  let a = 0.02;
  for (const [fc, bw, g] of [[700, 80, 1.0], [1200, 110, 0.55], [2600, 180, 0.35]]) a += g / (1 + ((f - fc) / bw) ** 2);
  return a;
};
function tone(f0, dur, { vibDepth = 0.03, seed = 5 } = {}) {
  const n = Math.round(SR * dur), out = new Float64Array(n), rnd = mulberry32(seed);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = f0 * (1 + vibDepth * Math.sin(2 * Math.PI * 5.5 * i / SR));
    ph += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h * f0 < 5200; h++) v += gainOf(h * f0) * Math.sin(ph * h) / Math.sqrt(h);
    const env = Math.min(1, i / (SR * 0.05)) * Math.min(1, (n - i) / (SR * 0.10));
    out[i] = 0.28 * v * env + (rnd() - 0.5) * 3e-4;
  }
  return out;
}

const x = tone(440, 6);
console.log(`\nsignál: ${x.length} vzorků (${(x.length / SR).toFixed(1)} s), vibrato 3 %\n`);

/* 1. Okna z `sprFrames` (krok 1024, jen okna celá uvnitř) */
const coreRef = new SprCore(SR, 4096);
const refVals = [], refPos = [];
for (let s = 0; s + 4096 <= x.length; s += 1024) {
  refVals.push(coreRef.of(x.subarray(s, s + 4096)));
  refPos.push(s);
}

/* 2. Okna živou cestou (krok 960, okno končí na konci rámce) */
const dsp = await createDsp({ frameSize: FRAME_SIZE, sampleRate: SR, fach: 'tenor', wasmUrl: WASM });
const state = createLiveState(SR, FRAME_SIZE);
const raw = [], rawPos = [], rollNow = [];
let pending = new Float64Array(0);
for (let b = 0; b + HOP <= x.length; b += HOP) {
  const block = x.subarray(b, b + HOP);
  const merged = new Float64Array(pending.length + block.length);
  merged.set(pending, 0); merged.set(block, pending.length);
  let off = 0;
  while (merged.length - off >= FRAME_SIZE) {
    const end = off + FRAME_SIZE;
    // Kontext před rámcem: co v `merged` chybí, doplní se z původního signálu.
    // Potřebujeme okno 4096 končící na `end`; kousek může ležet před `b`.
    const need = 4096 - end;
    const sprFull = need <= 0
      ? merged.subarray(end - 4096, end)
      : null;
    const snap = feedFrame(state, dsp, merged.subarray(off, end), sprFull);
    if (Number.isFinite(snap.sprLast)) {
      raw.push(snap.sprLast);
      rawPos.push(b + end - 4096);
      rollNow.push(snap.spr);
    }
    off += HOP;
  }
  pending = merged.slice(off);
}

/* 3. Okna na STEJNÝCH pozicích oběma cestami — musí být číslo na číslo stejná */
let worst = 0, same = 0;
for (let i = 0; i < refPos.length; i++) {
  const pos = refPos[i];
  const j = rawPos.indexOf(pos);
  if (j < 0) continue;
  const d = Math.abs(refVals[i] - raw[j]);
  worst = Math.max(worst, d); same++;
}
console.log(`okna na stejné pozici: ${same}, největší rozdíl ${worst.toExponential(1)} dB`);
console.log('  (když je 0, jádro počítá totéž a rozdíl je jen ve statisticce/pozicích)\n');

console.log(`sprFrames        : ${sprFrames(x, SR).toFixed(3)}   (krok 1024, ${refVals.length} oken)`);
console.log(`živě raw p90     : ${percentile(raw, 0.9).toFixed(3)}   (krok ${HOP}, ${raw.length} oken)`);
console.log(`živě raw medián  : ${median(raw).toFixed(3)}`);
console.log(`živě sprSamples  : ${state.sprSamples.length} hodnot, medián ${median(state.sprSamples).toFixed(3)}`);
console.log(`živě sprRoll     : ${state.sprRoll.length} hodnot, p90 ${percentile(state.sprRoll, 0.9).toFixed(3)}`);
console.log(`živě „SPR teď" (poslední): ${rollNow[rollNow.length - 1].toFixed(3)}\n`);

/* 4. Kde se v rámci tónu hodnoty berou — rozptyl po čase */
console.log('průběh raw SPR po 0,1 s (krok 5 rámců):');
let line = '';
for (let i = 0; i < raw.length; i += 5) {
  line += raw[i].toFixed(1).padStart(7);
  if (((i / 5) + 1) % 8 === 0) { console.log('  ' + line); line = ''; }
}
if (line) console.log('  ' + line);
console.log('\nHotovo.');
