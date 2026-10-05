#!/usr/bin/env node
/**
 * Měření pro rozhodnutí, JAK detailně kreslit SPR v čase.
 *
 * Otázka: stačí segmenty 0,5 s, nebo je potřeba kreslit po rámcích?
 * Odpověď musí být naměřená na REÁLNÝCH nahrávkách, ne na syntetice —
 * kolísání ringu je vlastnost hlasu, ne signálu.
 *
 * Pro každý dlouhý tón vypíše dvě časové řady:
 *   A) segmenty 0,5 s  (p90 přes okna 4096 uvnitř segmentu)
 *   B) rámce, krok 21 ms (okno 4096, jedna hodnota na okno) + EMA jako v živém
 * a spočítá rozkmit obou — kolik dB se v průběhu tónu skutečně ujede.
 *
 * Použití: node tools/diag-spr-prubeh.mjs soubor.wav [minDur]
 */
import { readFileSync } from 'node:fs';
import { analyze, sprFrames, percentile, SPR_NFFT } from '../src/analysis.js';

function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('není RIFF/WAV');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data') data = b.subarray(body, body + sz);
    off = body + sz + (sz & 1);
  }
  if (!fmt || !data) throw new Error('chybí fmt/data');
  const { channels, bits, format } = fmt;
  const n = Math.floor(data.length / (channels * bits / 8));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * channels * (bits / 8);
    let v;
    if (bits === 16) v = data.readInt16LE(o) / 32768;
    else if (bits === 32 && format === 3) v = data.readFloatLE(o);
    else if (bits === 8) v = (data[o] - 128) / 128;
    else if (bits === 24) v = ((data[o] | (data[o + 1] << 8) | (data[o + 2] << 16)) << 8 >> 8) / 8388608;
    else throw new Error('nepodporovaná bitová hloubka ' + bits);
    out[i] = v;
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}

const file = process.argv[2];
const minDur = Number(process.argv[3] || 0.8);
const { samples, sampleRate: SR } = readWav(file);
console.log(`\n### ${file} — ${(samples.length / SR).toFixed(1)} s, ${SR} Hz`);

const res = analyze(samples, SR, { fach: 'tenor' });
console.log(`tónů ${res.summary.n_notes}, vyřazeno ${res.dropped?.length ?? '?'}`
  + `, SPR medián ${res.summary.spr_median?.toFixed(2)} / nový ${res.summary.spr_novy_median?.toFixed(2)} dB`);

const long = res.notes.filter(n => n.dur >= minDur);
console.log(`dlouhých tónů (>= ${minDur} s): ${long.length}\n`);

const stats = [];
for (const n of long.slice(0, 12)) {
  const i0 = Math.round(n.t_start * SR), i1 = Math.round(n.t_end * SR);
  const seg = samples.subarray(i0, i1);
  const dur = seg.length / SR;
  const inn = seg.subarray(Math.round(0.20 * seg.length), Math.round(0.80 * seg.length));

  // A) segmenty 0,5 s
  const SEG = Math.round(0.5 * SR);
  const A = [];
  for (let s = 0; s + SEG <= inn.length; s += SEG) A.push(sprFrames(inn.subarray(s, s + SEG), SR));

  // B) rámce, krok 21 ms + EMA 0,35 (jako živý indikátor)
  const hop = Math.max(128, Math.round(SPR_NFFT / 4));
  const raw = [];
  for (let s = 0; s + SPR_NFFT <= inn.length; s += hop) raw.push(sprFrames(inn.subarray(s, s + SPR_NFFT), SR, { q: 0.5 }));
  let ema = NaN; const B = raw.map(v => (ema = ema !== ema ? v : 0.35 * v + 0.65 * ema));

  const spread = (v) => v.length ? Math.max(...v) - Math.min(...v) : NaN;
  const iqr = (v) => { const s = [...v].sort((a, b) => a - b); return percentile(s, 0.75) - percentile(s, 0.25); };
  console.log(`${n.note.padEnd(4)} ${n.t_start.toFixed(1)}-${n.t_end.toFixed(1)} s (${dur.toFixed(1)} s) f0 ${n.f0.toFixed(0)} Hz`);
  console.log(`   tón jako celek: SPR ${n.spr.toFixed(2)} / nový ${n.spr_novy.toFixed(2)} dB`);
  console.log(`   A) ${A.length} segmentů 0,5 s: ${A.map(v => v.toFixed(1)).join(' ')}`);
  console.log(`      rozkmit ${spread(A).toFixed(2)} dB · IQR ${iqr(A).toFixed(2)} dB`);
  console.log(`   B) ${raw.length} rámců (${(hop / SR * 1000).toFixed(0)} ms): rozkmit surově ${spread(raw).toFixed(2)} dB · po EMA ${spread(B).toFixed(2)} dB · IQR(EMA) ${iqr(B).toFixed(2)} dB`);
  stats.push({ dur, aSpread: spread(A), aIqr: iqr(A), bSpread: spread(B), bIqr: iqr(B), nSeg: A.length, nFrame: raw.length });
}

if (stats.length) {
  const med = (v) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
  console.log('\n### souhrn');
  console.log(`rozkmit uvnitř tónu — segmenty 0,5 s: medián ${med(stats.map(s => s.aSpread)).toFixed(2)} dB`
    + ` · rámce po EMA: medián ${med(stats.map(s => s.bSpread)).toFixed(2)} dB`);
  console.log(`počet hodnot na tón — segmenty: ${med(stats.map(s => s.nSeg)).toFixed(1)}`
    + ` · rámce: ${med(stats.map(s => s.nFrame)).toFixed(0)}`);
}
