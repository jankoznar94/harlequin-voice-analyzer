#!/usr/bin/env node
/**
 * Srovnání JS vs WASM na ŽIVÉM rámci — o kolik se zkrátí doba zpracování
 * jednoho bloku a jaký je v tom rozptyl.
 *
 * Rozptyl je důležitější než průměr: živý indikátor cuká, když jeden rámec
 * trvá 0,2 ms a další 3 ms. Proto se měří i p99 a maximum.
 *
 * Použití: node tools/bench-wasm.mjs [--wasm build/dsp.wasm] [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { pitchTrack, ltas } from '../src/analysis.js';

const ROOT = path.join(import.meta.dirname, '..');
const wasmPath = path.join(ROOT, 'wasm', 'build', 'dsp.wasm');

const bytes = fs.readFileSync(wasmPath);
const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { abort: () => { throw new Error('abort'); } } });
const ex = inst.exports;
const mem = ex.memory;
const f64at = (ptr, n) => new Float64Array(mem.buffer, ptr, n);

const SR = 48000;
const FRAME = 2048;
const BLOCK_MS = 20;                        // tak chodí zvuk z AudioWorkletu
const blockN = Math.round(SR * BLOCK_MS / 1000);

/* signál: 10 s zpěvu (směs tónů), ať se netestuje jen na tichu */
function signal(seconds = 10) {
  const n = SR * seconds;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f0 = 220 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t));
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
    s[i] = 0.35 * v;
  }
  return s;
}
const sig = signal();
const frames = Math.floor((sig.length - FRAME) / blockN);

function stats(runs) {
  const r = [...runs].sort((a, b) => a - b);
  const q = (p) => r[Math.min(r.length - 1, Math.floor(p * r.length))];
  return {
    median: q(0.5),
    p99: q(0.99),
    max: r[r.length - 1],
    mean: r.reduce((a, b) => a + b, 0) / r.length,
  };
}

function benchLive(label, fn, iters) {
  for (let i = 0; i < 200; i++) fn(i);        // zahřátí + JIT
  const runs = [];
  for (let i = 0; i < iters; i++) {
    const a = performance.now();
    fn(i);
    runs.push(performance.now() - a);
  }
  return { label, ...stats(runs) };
}

ex.init(FRAME, SR, 70, 1200, 0.15);
const inPtr = ex.inputPtr();

const win = new Float64Array(FRAME);
for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1));

const results = [];

/* JS: dnešní cesta — pitchTrack + ltas na každém bloku */
results.push(benchLive('JS  YIN + spektrum', (i) => {
  const start = (i % frames) * blockN;
  const blk = sig.subarray(start, start + FRAME);
  pitchTrack(blk, SR, { frameSize: FRAME, hopSize: FRAME });
  ltas(blk, SR, FRAME, FRAME);
}, frames));

/* WASM: kopie do paměti + jeden přechod hranice */
results.push(benchLive('WASM YIN + spektrum', (i) => {
  const start = (i % frames) * blockN;
  f64at(inPtr, FRAME).set(sig.subarray(start, start + FRAME));
  ex.liveProcess();
}, frames));

/* WASM bez kopie — jen výpočet, ať je vidět cena přechodu hranice */
results.push(benchLive('WASM jen výpočet (bez kopie)', (i) => {
  ex.liveProcess();
}, frames));

/* ── výstup ─────────────────────────────────────────────────────────────── */
console.log('\nŽivý rámec — blok 20 ms, rámec 2048 vzorků @48 kHz\n');
console.log('cesta                          medián      p99       max    rezerva(medián)');
for (const r of results) {
  const rez = BLOCK_MS / r.median;
  console.log(`${r.label.padEnd(30)} ${r.median.toFixed(3).padStart(8)} ms ${r.p99.toFixed(3).padStart(8)} ${r.max.toFixed(3).padStart(8)}   ${rez.toFixed(0)}×`);
}

const js = results[0], wasm = results[1];
console.log(`\nZrychlení WASM oproti JS: ${(js.median / wasm.median).toFixed(2)}× (medián), ${(js.max / wasm.max).toFixed(2)}× (max)`);
console.log(`Rozptyl (max/medián): JS ${(js.max / js.median).toFixed(1)}×, WASM ${(wasm.max / wasm.median).toFixed(1)}×`);

const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ blockMs: BLOCK_MS, results }, null, 2));
console.log('');
