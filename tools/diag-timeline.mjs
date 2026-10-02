import { readFileSync } from 'node:fs';
import { pitchTrack, hzToNote } from '../src/analysis.js';

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
const { times, f0 } = pitchTrack(samples, sampleRate);
const T = samples.length / sampleRate;

// timeline po 0,25 s: mediánová nota + rozptyl, ať je vidět struktura
let line = '';
const out = [];
for (let t = 0; t + 0.25 <= T; t += 0.25) {
  const v = [];
  for (let i = 0; i < f0.length; i++) if (times[i] >= t && times[i] < t + 0.25 && f0[i] > 0) v.push(f0[i]);
  if (v.length < 3) { out.push([t, null, 0]); continue; }
  v.sort((a, b) => a - b);
  const med = v[v.length >> 1];
  const sd = Math.sqrt(v.reduce((s, x) => s + (1200 * Math.log2(x / med)) ** 2, 0) / v.length);
  out.push([t, med, sd]);
}
console.log('t(s)  nota  0,25s okna not (nota / centová SD / znělost)');
let acc = '';
for (let i = 0; i < out.length; i++) {
  const [t, med, sd] = out[i];
  const cell = med ? (hzToNote(med) + (sd > 45 ? '~' : ' ')).padEnd(6) : '.     ';
  acc += cell;
  if ((i + 1) % 16 === 0) { console.log(String((i - 15) * 0.25).padStart(5) + ' ' + acc); acc = ''; }
}
if (acc) console.log('   ... ' + acc);
console.log('\n(~ = nestabilní, SD > 45 centů)');
