#!/usr/bin/env node
/**
 * Na REÁLNÉ nahrávce: které tóny analýza najde a které vyřadí — a co se stane,
 * když se z nahrávky vyřízne JEN nízký tón (sám, bez okolí).
 *
 * Použití: node tools/diag-nizke-real.mjs soubor.wav [fach]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { analyze } from '../src/analysis.js';

function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('není RIFF/WAV');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = b.subarray(body, body + sz);
    off = body + sz + (sz & 1);
  }
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
      acc += v;
    }
    out[i] = acc / channels;
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}
function writeWav(path, x, sr) {
  const n = x.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  writeFileSync(path, buf);
}

const [path, fach = 'tenor'] = process.argv.slice(2);
const { samples, sampleRate } = readWav(path);
const res = analyze(samples, sampleRate, { fach, progress: () => {} });

console.log(`soubor ${path}  ${res.duration_s.toFixed(1)} s @ ${sampleRate} Hz`);
console.log(`tónů ${res.n_notes}, vyřazeno ${res.n_dropped}, pásmo ${Math.round(res.band.limit)} Hz valid=${res.band.valid}`);
console.log('\nNALEZENÉ TÓNY (od nejnižšího):');
const notes = [...res.notes].sort((a, b) => a.f0 - b.f0);
for (const n of notes.slice(0, 12)) console.log(`  ${n.note.padEnd(4)} ${n.f0.toFixed(1).padStart(7)} Hz  ${n.t_start.toFixed(2)}–${n.t_end.toFixed(2)} s  dur ${(n.t_end - n.t_start).toFixed(2)} s  SPR ${n.spr?.toFixed(1) ?? '—'}`);
console.log('\nVYŘAZENÉ ÚSEKY:');
for (const d of res.dropped) console.log(`  ${d.t0.toFixed(2)}–${d.t1.toFixed(2)} s  ${d.why}`);

// Vyříznout NEJNIŽŠÍ nalezený tón (+ okolí 0,3 s) a změřit ho samotný.
const low = notes[0];
if (low) {
  const a = Math.max(0, Math.floor((low.t_start - 0.3) * sampleRate));
  const b = Math.min(samples.length, Math.ceil((low.t_end + 0.3) * sampleRate));
  const cut = samples.subarray(a, b);
  const r2 = analyze(cut, sampleRate, { fach, progress: () => {} });
  console.log(`\nVYŘÍZNUTÝ NEJNIŽŠÍ TÓN ${low.note} (${((b - a) / sampleRate).toFixed(2)} s): tónů ${r2.n_notes}, vyřazeno ${r2.n_dropped} ${JSON.stringify((r2.dropped || []).map(d => d.why))}, peak ${r2.peak_dbfs.toFixed(1)} dBFS, unusable=${!!r2.summary.spr_unusable}`);
  if (r2.notes.length) console.log(`  → ${r2.notes.map(n => `${n.note} ${n.f0.toFixed(1)} Hz SPR ${n.spr?.toFixed(1)}`).join(', ')}`);
  const out = '/home/martin_fabian/.cache/va-nizky-vyrez.wav';
  writeWav(out, cut, sampleRate);
  console.log(`  (uloženo ${out})`);
}
