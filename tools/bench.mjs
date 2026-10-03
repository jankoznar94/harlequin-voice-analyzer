#!/usr/bin/env node
/**
 * Měření výkonu DSP jádra — kolik rezervy je na živou zpětnou vazbu.
 *
 * Měří se DVĚ různé věci, které se pletou dohromady:
 *   1. JEDNORÁZOVÁ analýza nahrávky (analyze) — uživatel čeká na výsledek
 *   2. ŽIVÝ rámec — jeden blok vzorků tak, jak přichází z mikrofonu
 *
 * Pro živou vazbu rozhoduje jen (2) a jeho latence, ne celková doba nahrávky.
 *
 * Použití: node tools/bench.mjs [audio.wav] [--json out.json]
 */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

import { analyze, pitchTrack, ltas, spr, fhe, lpcBurg, lpcSpectrum, findFormants } from '../src/analysis.js';

function readWav(path) {
  const b = fs.readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('není RIFF/WAV');
  let o = 12, fmt = null;
  while (o < b.length - 8) {
    const id = b.toString('ascii', o, o + 4);
    const sz = b.readUInt32LE(o + 4);
    if (id === 'fmt ') {
      fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    }
    o += 8 + sz + (sz & 1);
  }
  const bytes = fmt.bits / 8;
  const n = Math.floor((b.length - 44) / (bytes * fmt.ch));
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const off = 44 + i * bytes * fmt.ch;
    s[i] = fmt.bits === 16 ? b.readInt16LE(off) / 32768
      : fmt.bits === 32 ? b.readFloatLE(off)
        : (b.readUInt8(off) - 128) / 128;
  }
  return { samples: s, sampleRate: fmt.sr };
}

/** Spustí fn tolikrát, aby to běželo aspoň minMs, a vrátí medián ms na běh. */
function bench(fn, minMs = 400, warmup = 20) {
  for (let i = 0; i < warmup; i++) fn();
  const runs = [];
  const t0 = performance.now();
  while (performance.now() - t0 < minMs) {
    const a = performance.now();
    fn();
    runs.push(performance.now() - a);
  }
  runs.sort((x, y) => x - y);
  return runs[runs.length >> 1];
}

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const wavPath = args.find(a => a.endsWith('.wav'))
  || process.env.HOME + '/.cache/vaud-test/zpev.wav';

const { samples, sampleRate } = readWav(wavPath);
const dur = samples.length / sampleRate;

const out = { audio: wavPath, seconds: +dur.toFixed(2), sampleRate, results: {} };
const say = (k, ms, note = '') => {
  out.results[k] = { ms: +ms.toFixed(3), note };
  const hz = 1000 / ms;
  console.log(`${k.padEnd(34)} ${ms.toFixed(3).padStart(9)} ms   ${note}`);
};

console.log(`\nAudio: ${wavPath.split('/').pop()}  ${dur.toFixed(1)} s  ${sampleRate} Hz\n`);

/* ── 1. celková analýza nahrávky ─────────────────────────────────────────── */
{
  const ms = bench(() => analyze(samples, sampleRate, { fach: 'tenor' }), 1500, 1);
  say('analyze (celá nahrávka)', ms, `${(dur / (ms / 1000)).toFixed(1)}× realtime`);
}

/* ── 2. živý rámec — jeden blok z mikrofonu ──────────────────────────────── */
// Simulace živého vstupu: blok 20 ms, analýza potřebuje ~40 ms kontextu.
const blockMs = 20;
const blockN = Math.round(sampleRate * blockMs / 1000);
const ctxN = 2048;               // rámec, na kterém dnes stojí YIN

// 2a. jen výška (YIN) na klouzavém okně
{
  let pos = ctxN;
  const ms = bench(() => {
    const start = (pos += blockN) % (samples.length - ctxN);
    pitchTrack(samples.subarray(start, start + ctxN), sampleRate, { frameSize: ctxN, hopSize: ctxN });
  }, 600);
  const budget = blockMs;
  say('živý rámec: YIN (20 ms blok)', ms, `rezerva ${(budget / ms).toFixed(1)}×`);
}

// 2b. YIN + spektrální metr (SPR/FHE) na stejném bloku
{
  let pos = ctxN;
  const win = new Float64Array(ctxN);
  for (let i = 0; i < ctxN; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (ctxN - 1));
  const ms = bench(() => {
    const start = (pos += blockN) % (samples.length - ctxN);
    const blk = samples.subarray(start, start + ctxN);
    pitchTrack(blk, sampleRate, { frameSize: ctxN, hopSize: ctxN });
    ltas(blk, sampleRate, ctxN, ctxN);
  }, 600);
  say('živý rámec: YIN + spektrum', ms, `rezerva ${(blockMs / ms).toFixed(1)}×`);
}

// 2c. co by stál formantový odhad (LPC) na živém rámci
{
  const ms = bench(() => {
    const x = samples.subarray(0, 2048);
    const a = lpcBurg(x, 18);
    lpcSpectrum(a, sampleRate, 256, 5500);
  }, 600);
  say('živý rámec: LPC (2048 vz.)', ms, `rezerva ${(blockMs / ms).toFixed(1)}×`);
}

/* ── 3. kde se ztrácí čas v analyze() ───────────────────────────────────── */
{
  const t1 = bench(() => pitchTrack(samples, sampleRate), 700, 1);
  say('  └ pitchTrack (celá)', t1);
  const t2 = bench(() => ltas(samples, sampleRate, 4096), 700, 1);
  say('  └ ltas 4096 (celá)', t2);
  const nChunks = Math.floor(samples.length / sampleRate) ;
  const t3 = bench(() => {
    for (let k = 0; k < 25; k++) findFormants(Float64Array.from({ length: 19 }, (_, i) => i * 0.01), 10000);
  }, 700, 1);
  say('  └ 25× LPC formanty @10k', t3);
}

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));
console.log('');
