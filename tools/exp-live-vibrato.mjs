#!/usr/bin/env node
/**
 * EXPERIMENT: platí korekce SPR (po rámcích, horní percentil) i pro ŽIVÝ režim?
 *
 * PROČ: oprava měření ringu (`sprFrames`, p90) je nasazená jen v analýze
 * NAHRÁVKY. Živý indikátor počítá SPR z JEDNOHO klouzavého průměru spektra —
 * tedy přesně tím způsobem, u kterého bylo naměřeno, že vibrato sráží číslo
 * o 4,6 dB dolů. Otázka je, jak je to velké v živém režimu (okno 2048, rámce
 * se překrývají po 20 ms) a co s tím udělá stejná korekce.
 *
 * Měří se proti ZNÁMÉ PRAVDĚ: syntetický hlas s předepsanou amplitudou
 * harmonických, takže SPR je spočitatelný z definice (poměr dvou vrcholů).
 * Opakovatelnost by nestačila — metoda může být dokonale opakovatelná a přitom
 * systematicky lhát.
 *
 * Použití: node tools/exp-live-vibrato.mjs
 */
import path from 'node:path';

import { ltas, spr, sprFrames, peakInterp, yinFrame, fft } from '../src/analysis.js';
import { FRAME_SIZE, BLOCK_MS, createLiveState, feedFrame } from '../src/live.js';
import { createDsp } from '../src/dsp-backend.js';

const ROOT = path.join(import.meta.dirname, '..');
const WASM = path.join(ROOT, 'wasm', 'build', 'dsp.wasm');

const SR = 48000;
const FRAME = FRAME_SIZE;                       // 2048
const HOP = Math.round(SR * BLOCK_MS / 1000);   // 960 = 20 ms

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))] : NaN; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Synth jako v live-check.mjs (aby čísla byla srovnatelná s živým testem),
 * ale s VYTAŽENOU obálkou harmonických — bez ní by nešla spočítat pravda.
 */
function envGain(f, bright = 1) {
  const formants = [[700, 80, 1.0], [1200, 110, 0.55], [2600, 180, 0.35 * bright]];
  let amp = 0;
  for (const [fc, bw, g] of formants) amp += g / (1 + Math.pow((f - fc) / bw, 2));
  return amp + 0.02;
}

/** Tón s vibratem; fáze se INTEGRUJE (jinak je syntéza fázově nespojitá). */
function steadyTone(f0, dur, { vibDepth = 0, vibRate = 5.5, bright = 1, seed = 5 } = {}) {
  const n = Math.round(SR * dur);
  const out = new Float64Array(n);
  const rnd = mulberry32(seed);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 * (1 + vibDepth * Math.sin(2 * Math.PI * vibRate * t));
    phase += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h * f0 < 5200; h++) {
      v += envGain(h * f0, bright) * Math.sin(phase * h) / Math.sqrt(h);
    }
    const env = Math.min(1, i / (SR * 0.05)) * Math.min(1, (n - i) / (SR * 0.10));
    out[i] = 0.28 * v * env + (rnd() - 0.5) * 3e-4;
  }
  return out;
}

/** PRAVDA: poměr amplitud nejvyšších harmonických v obou pásmech. */
function trueSPR(f0, bright = 1) {
  let lo = 0, hi = 0;
  for (let h = 1; h * f0 < 5200; h++) {
    const f = h * f0;
    const a = envGain(f, bright) / Math.sqrt(h);
    if (f < 2000) lo = Math.max(lo, a);
    if (f >= 2000 && f <= 4000) hi = Math.max(hi, a);
  }
  return (lo && hi) ? 20 * Math.log10(hi / lo) : NaN;
}

/* ── živé jádro: čteme VÝKONOVÉ SPEKTRUM každého rámce přímo ─────────────── */

/**
 * Prožene signál živou cestou a pro každý rámec si vezme surové výkonové
 * spektrum (ne jen vyhlazený kumulátor). Z něj se pak dají spočítat RŮZNÉ
 * statistiky nad stejnými daty — to je přesně to, co potřebujeme srovnat.
 */
async function framesOf(samples) {
  const dsp = await createDsp({ frameSize: FRAME, sampleRate: SR, fach: 'tenor', wasmUrl: WASM });
  if (dsp.kind !== 'wasm') throw new Error('WASM backend se nenačetl');
  const ex = dsp.ex;
  const binHz = SR / FRAME;

  // stejná metrika jako dnes živě: vrchol v pásmu na SUROVÉM binu
  const liveMetric = (acc) => {
    let hi = 0, lo = 0;
    for (let i = 1; i < acc.length; i++) {
      const f = i * binHz, p = acc[i];
      if (f >= 2000 && f <= 4000) { if (p > hi) hi = p; }
      else if (f < 2000) { if (p > lo) lo = p; }
    }
    return (hi > 0 && lo > 0) ? 10 * Math.log10(hi / lo) : NaN;
  };

  const out = [];
  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    const frame = samples.subarray(start, start + FRAME);
    const f0 = dsp.process(frame);
    const rms = dsp.rms(frame);
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    if (!(rms >= 0.010 && f0 > 0)) continue;      // stejná brána jako live.js
    const spec = new Float64Array(ex.specLength());
    spec.set(new Float64Array(ex.memory.buffer, ex.specPtr(), ex.specLength()));
    out.push({ t: start / SR, f0, dbfs, spec, binHz });
  }
  return out;
}

/** Nová živá metrika: SPR z jednoho rámce s INTERPOLOVANÝM vrcholem. */
function frameSprNew(rec) {
  const { spec, binHz } = rec;
  const freq = new Float64Array(spec.length);
  const db = new Float64Array(spec.length);
  for (let i = 0; i < spec.length; i++) {
    freq[i] = i * binHz;
    db[i] = 10 * Math.log10(spec[i] + 1e-20);
  }
  const s = { freq, db, binHz };
  const hi = peakInterp(s, 2000, 4000);
  const lo = peakInterp(s, 30, 2000);
  return (hi === hi && lo === lo) ? hi - lo : NaN;
}

/** dnešní živá metrika z jednoho rámce (bez vyhlazení) */
function frameSprNow(rec) {
  const { spec, binHz } = rec;
  let hi = 0, lo = 0;
  for (let i = 1; i < spec.length; i++) {
    const f = i * binHz, p = spec[i];
    if (f >= 2000 && f <= 4000) { if (p > hi) hi = p; }
    else if (f < 2000) { if (p > lo) lo = p; }
  }
  return (hi > 0 && lo > 0) ? 10 * Math.log10(hi / lo) : NaN;
}

/* ── běh ─────────────────────────────────────────────────────────────────── */

console.log('\nŽIVÁ CESTA vs ZNÁMÁ PRAVDA — SPR v dB (pravda = z amplitud harmonických)');
console.log('okno 2048 @48 kHz, rámce po 20 ms, držený tón 6 s\n');

const CASES = [
  ['čistý', { vibDepth: 0 }],
  ['vibrato 2 %', { vibDepth: 0.02 }],
  ['vibrato 3 %', { vibDepth: 0.03 }],
  ['vibrato 5 %', { vibDepth: 0.05 }],
];
const F0S = [196, 247, 330, 392, 494];

const rows = [];
console.log('tón'.padEnd(12) + 'pravda'.padStart(9) + 'OFF spr'.padStart(10) + 'OFF p90'.padStart(10)
  + 'ŽIVĚ teď'.padStart(10) + 'ŽIVĚ p90'.padStart(10) + 'ŽIVĚ p90 1s'.padStart(13));

for (const [label, opts] of CASES) {
  for (const f0 of F0S) {
    const tone = steadyTone(f0, 6, opts);
    const truth = trueSPR(f0);

    const offOld = spr(ltas(tone, SR, 4096));
    const offNew = sprFrames(tone, SR);

    const recs = await framesOf(tone);
    const nowVals = recs.map(frameSprNow).filter(v => v === v);
    const newVals = recs.map(frameSprNew).filter(v => v === v);

    // „co by ukázal indikátor, kdyby metriku držel jako dnešní kumulátor“:
    // EMA s α = 0,12 (stejná paměť ~0,17 s) a z ní medián celého měření
    const ema = (vals) => {
      let a = null;
      const out = [];
      for (const v of vals) { a = (a === null) ? v : a + 0.12 * (v - a); out.push(a); }
      return out;
    };
    const liveNow = median(ema(nowVals));
    const liveNew = pct(newVals, 0.90);
    // poslední sekunda (reálné použití: zpěvák drží tón a kouká na číslo)
    const lastSec = newVals.filter((_, i) => recs[i].t >= 5.0);
    const liveNew1s = pct(lastSec, 0.90);

    console.log(
      `${label} ${f0} Hz`.padEnd(12)
      + truth.toFixed(2).padStart(9)
      + offOld.toFixed(2).padStart(10)
      + offNew.toFixed(2).padStart(10)
      + liveNow.toFixed(2).padStart(10)
      + liveNew.toFixed(2).padStart(10)
      + `${liveNew1s.toFixed(2)} (${lastSec.length}r)`.padStart(13));

    rows.push({ label, f0, truth, offOld, offNew, liveNow, liveNew, liveNew1s });
  }
}

/* ── souhrn: chyba proti pravdě ──────────────────────────────────────────── */

const err = (key) => {
  const e = rows.filter(r => Number.isFinite(r[key]) && Number.isFinite(r.truth))
    .map(r => Math.abs(r[key] - r.truth));
  return { med: median(e), max: Math.max(...e) };
};
console.log('\nCHYBA PROTI PRAVDĚ (medián |chyby| / maximum)');
for (const [name, key] of [
  ['nahrávka: průměr spekter (staré)', 'offOld'],
  ['nahrávka: p90 po rámcích (nové)', 'offNew'],
  ['živě: EMA kumulátor (dnes)', 'liveNow'],
  ['živě: p90 po rámcích (nové)', 'liveNew'],
  ['živě: p90, poslední 1 s', 'liveNew1s'],
]) {
  const e = err(key);
  console.log(`  ${name.padEnd(34)} ${e.med.toFixed(2).padStart(5)} dB / ${e.max.toFixed(2).padStart(5)} dB`);
}

// systematický posun (znaménko) — u vibrata se čeká záporný
console.log('\nSMĚR CHYBY u vibrata (průměr kladný = nadhodnocuje, záporný = podhodnocuje)');
for (const [name, key] of [
  ['nahrávka: průměr spekter (staré)', 'offOld'],
  ['nahrávka: p90 po rámcích (nové)', 'offNew'],
  ['živě: EMA kumulátor (dnes)', 'liveNow'],
  ['živě: p90 po rámcích (nové)', 'liveNew'],
]) {
  const v = rows.filter(r => r.vibDepth === undefined && r.label !== 'čistý')
    .map(r => r[key] - r.truth).filter(Number.isFinite);
  console.log(`  ${name.padEnd(34)} ${mean(v).toFixed(2).padStart(6)} dB`);
}

console.log('\nHotovo.');
