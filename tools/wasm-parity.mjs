#!/usr/bin/env node
/**
 * Parita WASM ↔ JS. WASM jádro se smí použít jen tehdy, když dává stejná
 * čísla jako JS — jinak by se tiše změnilo vyhodnocení ringu.
 *
 * Porovnává se rámec po rámci: výška (YIN) i výkonové spektrum.
 *
 * Použití: node tools/wasm-parity.mjs [--wasm build/dsp.wasm]
 */
import fs from 'node:fs';
import path from 'node:path';

import { pitchTrack, fft } from '../src/analysis.js';

const ROOT = path.join(import.meta.dirname, '..');
const wasmPath = process.argv.includes('--wasm')
  ? process.argv[process.argv.indexOf('--wasm') + 1]
  : path.join(ROOT, 'wasm', 'build', 'dsp.wasm');

/* ── načtení WASM ────────────────────────────────────────────────────────── */
const bytes = fs.readFileSync(wasmPath);
const mod = new WebAssembly.Module(bytes);
const inst = new WebAssembly.Instance(mod, { env: { abort: () => { throw new Error('wasm abort'); } } });
const ex = inst.exports;
if (!ex.memory) throw new Error('WASM neexportuje memory — zkontroluj asconfig.json');

const mem = ex.memory;
const f64at = (ptr, n) => new Float64Array(mem.buffer, ptr, n);

/* ── referenční JS výpočet spektra (stejný postup jako powerSpectrum v JS) ── */
function jsPowerSpectrum(frame) {
  const n = frame.length;
  const half = n >> 1;
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  const re = new Float64Array(frame);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * win[i];
  fft(re, im);
  const p = new Float64Array(half);
  for (let i = 0; i < half; i++) p[i] = re[i] * re[i] + im[i] * im[i];
  return p;
}

/* ── deterministické signály (stejné jako v tools/parity.mjs) ────────────── */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function tone({ sr = 48000, dur = 0.6, f0 = 262, vibrato = 0, seed = 1 }) {
  const n = Math.round(sr * dur);
  const out = new Float64Array(n);
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f0 * (1 + vibrato * Math.sin(2 * Math.PI * 5.5 * t));
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
    const env = Math.min(1, i / (sr * 0.03)) * Math.min(1, (n - i) / (sr * 0.05));
    out[i] = 0.4 * v * env + (rnd() - 0.5) * 1e-4;
  }
  return out;
}
function noise({ sr = 48000, dur = 0.4, seed = 7 }) {
  const n = Math.round(sr * dur);
  const out = new Float64Array(n);
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) out[i] = (rnd() - 0.5) * 0.5;
  return out;
}
function silence({ sr = 48000, dur = 0.3 }) { return new Float64Array(Math.round(sr * dur)); }

const SR = 48000;
const FRAME = 2048;
const sigs = {
  'tón A3': tone({ f0: 220, seed: 11 }),
  'tón A4': tone({ f0: 440, seed: 12 }),
  'tón A4 s vibratem': tone({ f0: 440, vibrato: 0.02, seed: 13 }),
  'tón E5': tone({ f0: 659, seed: 14 }),
  'tón E1': tone({ f0: 82, seed: 15 }),
  'šum': noise({}),
  'ticho': silence({}),
};

/* ── init WASM ───────────────────────────────────────────────────────────── */
const fMin = 70, fMax = 1200, thr = 0.15;
ex.init(FRAME, SR, fMin, fMax, thr);
const inPtr = ex.inputPtr();
const specPtr = ex.specPtr();
const specLen = ex.specLength();
const hopSize = Math.round(0.010 * SR);

let checks = 0, fails = 0;

/**
 * Tolerance: WASM a JS se nutně liší v posledních bitech double (jiná
 * implementace cos/sin pro twiddle faktory, jiné pořadí sčítání). Naměřené
 * rozdíly jsou ~1e-13 Hz u výšky a ~3e-10 relativně u spektra.
 *
 * Mez je proto 1e-6 Hz, resp. 1e-8 relativně — to je pořád o ~10 řádů tvrdší
 * než nejmenší rozdíl, který by mohl změnit úsudek: jeden cent je 0,06 %
 * (6e-4 relativně) a prahy pro ring se pohybují v desetinách dB.
 * Když se sem někdy vkrade skutečná chyba (špatné okno, posunuté tau),
 * rozdíly budou o mnoho řádů větší a test to chytí.
 */
const F0_TOL = 1e-6;        // Hz
const SPEC_TOL = 1e-8;      // relativně

const report = (label, a, b, tol, unit = '') => {
  checks++;
  const d = Math.abs(a - b);
  if (Number.isNaN(a) && Number.isNaN(b)) return;
  if (d > tol) {
    fails++;
    console.log(`  ✗ ${label}: JS=${a}${unit} WASM=${b}${unit} rozdíl=${d.toExponential(3)}`);
  }
  return d;
};

for (const [name, samples] of Object.entries(sigs)) {
  const js = pitchTrack(samples, SR, { frameSize: FRAME, hopSize, fMin, fMax, threshold: thr });
  const nFrames = js.f0.length;
  let maxF0Diff = 0, maxSpecDiff = 0, f0Compared = 0;

  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * hopSize;
    const frame = samples.subarray(start, start + FRAME);

    // vstup do WASM
    f64at(inPtr, FRAME).set(frame);

    // výška
    const jsF0 = js.f0[fi];
    const wasmF0raw = ex.yinCompute();
    // JS pitchTrack nuluje rámce pod RMS prahem — stejné pravidlo aplikujeme i tady
    let rms = 0;
    for (let i = 0; i < FRAME; i++) rms += frame[i] * frame[i];
    rms = Math.sqrt(rms / FRAME);
    const wasmF0 = (wasmF0raw > 0 && rms >= 0.008) ? wasmF0raw : 0;

    const isZero = (v) => v === 0;
    if (!(isZero(jsF0) && isZero(wasmF0))) {
      f0Compared++;
      const d = report(`${name} rámec ${fi} f0`, jsF0, wasmF0, F0_TOL, ' Hz');
      if (d !== undefined && d > maxF0Diff) maxF0Diff = d;
    }

    // spektrum
    ex.powerSpectrum();
    const wasmSpec = f64at(specPtr, specLen);
    const jsSpec = jsPowerSpectrum(frame);
    for (let i = 0; i < specLen; i++) {
      const d = Math.abs(jsSpec[i] - wasmSpec[i]);
      const rel = d / (Math.abs(jsSpec[i]) + 1e-30);
      if (rel > maxSpecDiff) maxSpecDiff = rel;
      if (rel > SPEC_TOL) { fails++; console.log(`  ✗ ${name} rámec ${fi} spektrum bin ${i}: rel ${rel.toExponential(3)}`); }
    }
  }
  const ok = maxF0Diff <= F0_TOL && maxSpecDiff < SPEC_TOL;
  if (!ok) fails++;
  checks++;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(20)} rámců ${nFrames}, porovnáno f0 ${f0Compared}, ` +
    `max Δf0 ${maxF0Diff.toExponential(2)} Hz, max rel Δspektrum ${maxSpecDiff.toExponential(2)}`);
}

console.log(`\n═══ WASM PARITA: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══`);
process.exit(fails ? 1 : 0);
