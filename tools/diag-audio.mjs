import { readFileSync } from 'node:fs';
import { ltas, bandwidthLimit, spr, fhe, hzToNote } from '../src/analysis.js';

function loadWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = b.subarray(body, body + sz);
    off = body + sz + (sz & 1);
  }
  const n = Math.floor(data.length / (fmt.ch * fmt.bits / 8));
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (let c = 0; c < fmt.ch; c++) a += data.readInt16LE((i * fmt.ch + c) * (fmt.bits / 8)) / 32768;
    x[i] = a / fmt.ch;
  }
  return { samples: x, sampleRate: fmt.sr, fmt };
}

for (const p of process.argv.slice(2)) {
  const w = loadWav(p);
  console.log('===', p);
  if (!w) { console.log('   (není RIFF/WAV)'); continue; }
  const s = w.samples;
  let peak = 0, rms = 0, clipped = 0;
  for (let i = 0; i < s.length; i++) { const a = Math.abs(s[i]); if (a > peak) peak = a; if (a > 0.995) clipped++; rms += s[i] * s[i]; }
  rms = Math.sqrt(rms / s.length);
  console.log(`   ${w.fmt.ch} kanál, ${w.fmt.bits} bit, ${w.sampleRate} Hz, ${(s.length / w.sampleRate).toFixed(1)} s`);
  console.log(`   peak ${peak.toFixed(3)} (${(20 * Math.log10(peak + 1e-12)).toFixed(1)} dBFS), RMS ${(20 * Math.log10(rms + 1e-12)).toFixed(1)} dBFS, vzorků u limitu ${clipped}`);
  const spec = ltas(s, w.sampleRate);
  console.log(`   pásmo (drop 40 dB): ${Math.round(bandwidthLimit(spec))} Hz, SPR ${spr(spec).toFixed(1)} dB, FHE ${Math.round(fhe(spec))} Hz`);
  // spektrum po pásmech
  const bands = [[0, 500], [500, 1000], [1000, 2000], [2000, 3000], [3000, 4000], [4000, 5000], [5000, 6000], [6000, 8000], [8000, 12000], [12000, 16000]];
  const out = [];
  for (const [lo, hi] of bands) {
    let m = -Infinity;
    for (let i = 0; i < spec.freq.length; i++) if (spec.freq[i] >= lo && spec.freq[i] < hi && spec.db[i] > m) m = spec.db[i];
    out.push(`${lo / 1000}-${hi / 1000}k: ${m.toFixed(0)}`);
  }
  console.log('   peak dBFS po pásmech: ' + out.join(' | '));
}
