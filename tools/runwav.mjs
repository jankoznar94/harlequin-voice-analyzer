#!/usr/bin/env node
/** Rychlý běh JS jádra na WAV souboru. Použití: node tools/runwav.mjs audio.wav [fach] */
import { readFileSync } from 'node:fs';
import { analyze } from '../src/analysis.js';

function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('není RIFF/WAV');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = b.subarray(body, body + sz);
    }
    off = body + sz + (sz & 1);
  }
  if (!fmt || !data) throw new Error('chybí fmt/data');
  const { channels, bits, format } = fmt;
  const n = Math.floor(data.length / (channels * bits / 8));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * (bits / 8);
      let v;
      if (bits === 16) v = data.readInt16LE(p) / 32768;
      else if (bits === 32) v = (format === 3 ? data.readFloatLE(p) : data.readInt32LE(p) / 2147483648);
      else if (bits === 8) v = (data.readUInt8(p) - 128) / 128;
      else throw new Error('podporováno 8/16/32 bitů');
      acc += v;
    }
    out[i] = acc / channels;
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}

const [path, fach = 'tenor'] = process.argv.slice(2);
const { samples, sampleRate } = readWav(path);
const t0 = Date.now();
const res = analyze(samples, sampleRate, { fach });
const secs = (Date.now() - t0) / 1000;

console.log(`soubor      ${path}`);
console.log(`délka       ${res.duration_s.toFixed(1)} s @ ${sampleRate} Hz`);
console.log(`výpočet     ${secs.toFixed(1)} s`);
console.log(`tónů        ${res.n_notes}   (vyřazeno ${res.n_dropped})`);
console.log(`pásmo       ${Math.round(res.band.limit)} Hz, měřitelné=${res.band.valid}`);
console.log(`noty        ${res.notes.map(n => n.note).join(' ')}`);
console.log(`ring        ${res.summary.spr_unusable ? 'nelze měřit' : res.summary.ring_consistency_pct.toFixed(1) + ' % (' + res.summary.notes_with_ring + '/' + res.summary.n_notes + ')'}`);
console.log(`SPR medián  ${res.summary.spr_unusable ? '—' : res.summary.spr_median.toFixed(2) + ' dB ± ' + res.summary.spr_sd.toFixed(2)}`);
console.log(`FHE medián  ${res.summary.fhe_median ? Math.round(res.summary.fhe_median) + ' Hz' : '—'}`);
console.log('');
console.log('idx  tón    f0 Hz   dur   SPR    ring  F1    F1:F0%  HNR');
for (const n of res.notes) {
  const f = (v, d = 1) => (v === v && v !== null ? v.toFixed(d) : '—');
  console.log(
    String(n.idx).padStart(3) + '  ' + n.note.padEnd(5) +
    f(n.f0, 1).padStart(7) + '  ' + f(n.dur, 2).padStart(5) +
    '  ' + f(n.spr, 1).padStart(6) + '  ' + (n.ring_ok ? 'ANO ' : 'NE  ') +
    '  ' + f(n.f1, 0).padStart(5) + '  ' + f(n.f1_f0_err_pct, 1).padStart(6) +
    '  ' + f(n.hnr, 1).padStart(5));
}
console.log(JSON.stringify(res, (k, v) => (v === undefined ? null : v), 1).slice(0, 0));
