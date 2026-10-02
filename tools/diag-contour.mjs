import { readFileSync } from 'node:fs';
import { pitchTrack, medianFilter, segmentNotes, hzToNote } from '../src/analysis.js';

const b = readFileSync('/home/martin_fabian/vocal-lab/out/jan_tenor/_mono.wav');
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
const { times, f0 } = pitchTrack(x, fmt.sr);

console.log('--- kontura 7.0 - 15.0 s (kazdy 4. ramec):');
const vals = [];
for (let i = 0; i < f0.length; i++) {
  if (times[i] < 7 || times[i] > 15.0) continue;
  vals.push(f0[i]);
  if (i % 4) continue;
  console.log(times[i].toFixed(2).padStart(6), f0[i] > 0 ? f0[i].toFixed(1).padStart(7) + '  ' + hzToNote(f0[i]) : '     —');
}
const nz = vals.filter(v => v > 0).sort((a, b) => a - b);
const voiced = vals.length ? nz.length / vals.length : 0;
console.log('rámců v okně:', vals.length, 'znělých:', nz.length, (100 * voiced).toFixed(1) + '%');
const uniq = new Set(nz.map(v => hzToNote(v)));
console.log('unikátních not v okně:', uniq.size, [...uniq].join(' '));
const segs = segmentNotes(times, f0, { minDur: 0.3 });
console.log('\n--- segmenty (prvnich 14):');
segs.slice(0, 14).forEach((s, i) => console.log(String(i + 1).padStart(3), s[0].toFixed(2), '-', s[1].toFixed(2), ' dur', (s[1] - s[0]).toFixed(2)));
console.log('celkem segmentu:', segs.length);
