import { readFileSync } from 'node:fs';
import { fft, hzToNote, hzToCents } from '../src/analysis.js';

function loadWav(path) {
  const b = readFileSync(path);
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
  return { samples: x, sampleRate: fmt.sr };
}

const { samples, sampleRate } = loadWav(process.argv[2]);
const times = (process.argv[3] || '8.3,9.0,12.5,60.5').split(',').map(Number);
const N = 8192;

for (const t of times) {
  const start = Math.max(0, Math.round(t * sampleRate) - N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    re[i] = (samples[start + i] || 0) * w;
  }
  fft(re, im);
  const half = N >> 1, binHz = sampleRate / N;
  const db = new Float64Array(half);
  let mx = -Infinity;
  for (let i = 0; i < half; i++) { db[i] = 10 * Math.log10(re[i] * re[i] + im[i] * im[i] + 1e-20); if (db[i] > mx) mx = db[i]; }
  // lokální maxima do 2 kHz, aspoň 12 dB nad okolím
  const peaks = [];
  for (let i = 3; i < Math.floor(2000 / binHz); i++) {
    if (db[i] > db[i - 1] && db[i] >= db[i + 1] && db[i] > mx - 45) peaks.push([i * binHz, db[i] - mx]);
  }
  console.log(`\n=== t = ${t} s  (${peaks.length} peaků < 2 kHz) ===`);
  console.log('   Hz    rel dB');
  for (const [f, d] of peaks.slice(0, 26)) {
    console.log(`  ${f.toFixed(1).padStart(7)}  ${d.toFixed(1).padStart(6)}   ${hzToNote(f)}`);
  }
  // harmonická řada pro hypotetické f0
  for (const f0 of [146.8, 164.8, 174.6, 220, 293.7]) {
    let hits = 0;
    for (let k = 1; k * f0 < 1600; k++) {
      const target = k * f0;
      for (const [f] of peaks) if (Math.abs(hzToCents(f) - hzToCents(target)) < 40) { hits++; break; }
    }
    if (hits >= 3) console.log(`   hypotéza f0 ${f0} Hz → ${hits} harmonických nalezeno`);
  }
}
