#!/usr/bin/env node
/**
 * Kolik stojí kreslena casova rada SPR uvnitr tonu.
 *
 * Varianty:
 *   A) dnes: 1 hodnota na ton (p90 pres telo tonu)
 *   B) rada: klouzavy p90, okno 0,2 s, krok 0,05 s  -> detail v case
 *   C) rada jemna: okno 0,1 s, krok 0,02 s
 *
 * Meri se na REALNE nahravce (72,6 s) — pocet tonu, ktere radu dostanou,
 * a celkovy cas navic.
 *
 * Použití: node tools/bench-spr-serie.mjs soubor.wav
 */
import { readFileSync } from 'node:fs';
import { analyze, percentile, SPR_NFFT, SprCore } from '../src/analysis.js';

function readWav(path) {
  const b = readFileSync(path);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4); const body = off + 8;
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = b.subarray(body, body + sz);
    off = body + sz + (sz & 1);
  }
  const { channels, bits, format } = fmt;
  const n = Math.floor(data.length / (channels * bits / 8));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * channels * (bits / 8);
    out[i] = bits === 16 ? data.readInt16LE(o) / 32768 : bits === 32 && format === 3 ? data.readFloatLE(o) : (data[o] - 128) / 128;
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}

const file = process.argv[2];
const { samples, sampleRate: SR } = readWav(file);

let t0 = performance.now();
const res = analyze(samples, SR, { fach: 'tenor' });
const baseMs = performance.now() - t0;
console.log(`\n### ${file} — ${(samples.length / SR).toFixed(1)} s · analyze() ${baseMs.toFixed(0)} ms · tónů ${res.summary.n_notes}`);

/** Klouzavý p90: okno WIN vzorků, krok HOP vzorků, uvnitř okna rámce okna 4096. */
function series(x, SR_, winS, hopS) {
  const win = Math.round(winS * SR_), hop = Math.max(128, Math.round(hopS * SR_));
  if (x.length < win) return { vals: [], hop };
  const core = new SprCore(SR_, SPR_NFFT);
  const inner = Math.max(128, Math.round(SPR_NFFT / 4));
  const vals = [];
  for (let s = 0; s + win <= x.length; s += hop) {
    const seg = x.subarray(s, s + win);
    const tmp = [];
    for (let u = 0; u + SPR_NFFT <= seg.length; u += inner) {
      const v = core.of(seg.subarray(u, u + SPR_NFFT));
      if (v === v) tmp.push(v);
    }
    vals.push(tmp.length ? percentile(tmp, 0.90) : NaN);
  }
  return { vals, hop };
}

for (const [name, winS, hopS] of [['B) okno 0,2 s, krok 0,05 s', 0.2, 0.05], ['C) okno 0,1 s, krok 0,02 s', 0.1, 0.02]]) {
  const notes = res.notes.filter(n => n.dur >= 1.0);
  const t1 = performance.now();
  let total = 0, maxLen = 0;
  for (const n of notes) {
    const i0 = Math.round(n.t_start * SR), i1 = Math.round(n.t_end * SR);
    const { vals } = series(samples.subarray(i0, i1), SR, winS, hopS);
    total += vals.length; maxLen = Math.max(maxLen, vals.length);
  }
  console.log(`${name}: ${notes.length} tónů · ${total} hodnot · nejdelší řada ${maxLen}`
    + ` · ${(performance.now() - t1).toFixed(0)} ms navíc (${(100 * (performance.now() - t1) / baseMs).toFixed(0)} % analyze())`);
}

// Kolik hodnot na tón podle délky tónu
console.log('\nhodnot na tón (okno 0,2 s / krok 0,05 s):');
for (const n of res.notes.filter(x => x.dur >= 1.2).slice(0, 8)) {
  const { vals } = series(samples.subarray(Math.round(n.t_start * SR), Math.round(n.t_end * SR)), SR, 0.2, 0.05);
  console.log(`  ${n.note.padEnd(4)} ${n.dur.toFixed(1)} s -> ${vals.length} hodnot`);
}
