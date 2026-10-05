#!/usr/bin/env node
/**
 * Ověření časové řady SPR: co křivka ukáže na reálné nahrávce a na tónu,
 * který se v průběhu mění.
 *
 * Použití: node tools/check-spr-serie.mjs soubor.wav [minDur]
 */
import { readFileSync } from 'node:fs';
import { analyze, sprSeries, percentile, SPR_SERIE_MIN_DUR } from '../src/analysis.js';

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
const minDur = Number(process.argv[3] || 1.2);
const { samples, sampleRate: SR } = readWav(file);
const res = analyze(samples, SR, { fach: 'tenor' });

console.log(`\n### ${file} — ${(samples.length / SR).toFixed(1)} s · tónů ${res.summary.n_notes}`);
const withSer = res.notes.filter(n => n.spr_series?.length);
console.log(`tónů s časovou řadou: ${withSer.length} (z ${res.notes.length}), práh ${SPR_SERIE_MIN_DUR} s\n`);

/* Bod 1: medián řady vs uložené číslo tónu — křivka a číslo musí být
 * ze STEJNÉHO měření, jinak by si graf a report odporovaly. */
const d = [];
for (const n of withSer) {
  const med = percentile(n.spr_series.map(p => p[1]), 0.5);
  d.push(med - n.spr_novy);
}
const med = (v) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
console.log(`medián(řada) − spr_novy : medián ${med(d).toFixed(2)} dB, rozsah ${Math.min(...d).toFixed(2)}…${Math.max(...d).toFixed(2)} dB`);

/* Bod 2: co křivka ukáže, že jedno číslo neukáže. */
console.log('\ntón    dur   bodů  rozkmit  1.čtvrtina  poslední   pokles   (významné kolísání = IQR > 2 dB)');
for (const n of withSer.filter(x => x.dur >= minDur).slice(0, 12)) {
  const v = n.spr_series.map(p => p[1]);
  const q1 = percentile(v.slice(0, Math.max(1, Math.floor(v.length / 4))), 0.5);
  const ql = percentile(v.slice(Math.max(0, v.length - Math.floor(v.length / 4))), 0.5);
  const iqr = percentile([...v].sort((a, b) => a - b), 0.75) - percentile([...v].sort((a, b) => a - b), 0.25);
  console.log(`${n.note.padEnd(5)} ${n.dur.toFixed(1)}s ${String(v.length).padStart(5)} ${(Math.max(...v) - Math.min(...v)).toFixed(1).padStart(8)}`
    + ` ${q1.toFixed(1).padStart(10)} ${ql.toFixed(1).padStart(10)} ${(ql - q1).toFixed(1).padStart(8)}   ${iqr > 2 ? '<--' : ''}`);
}

/* Bod 3: ověření na tónu s ŘÍZENOU změnou ringu — křivka musí změnu ukázat. */
console.log('\n### kontrola: tón, kterému ring v polovině spadne (syntéza se známou pravdou)');
const SR2 = 48000, N = Math.round(6 * SR2);
function tone() {
  const out = new Float64Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR2;
    const bright = t < 3 ? 1 : 0.10;
    ph += 2 * Math.PI * 220 / SR2;
    let v = 0;
    for (let h = 1; h * 220 < 5200; h++) {
      const f = h * 220;
      const F = [[700, 1.0, 110], [1220, 0.5, 130], [2600, bright * 0.35, 190]];
      let g = 0; for (const [fc, a, bw] of F) g += a / (1 + ((f - fc) / bw) ** 2);
      v += Math.max(0.03, g) * Math.sin(h * ph) / Math.sqrt(h);
    }
    out[i] = 0.25 * v;
  }
  return out;
}
const t = tone();
const ser = sprSeries(t, SR2);
const half = Math.floor(ser.length / 2);
console.log(`bodů ${ser.length} · 1. polovina ${percentile(ser.slice(0, half).map(p => p[1]), 0.5).toFixed(1)} dB`
  + ` · 2. polovina ${percentile(ser.slice(half).map(p => p[1]), 0.5).toFixed(1)} dB`
  + ` · pokles ${(percentile(ser.slice(half).map(p => p[1]), 0.5) - percentile(ser.slice(0, half).map(p => p[1]), 0.5)).toFixed(1)} dB`);
console.log('(kdyby řada změnu neukázala, je k ničemu)');
