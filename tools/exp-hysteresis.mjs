/** Ladění hysterezního čítače: kolik notových úseků najde při různých prahách. */
import { readFileSync } from 'node:fs';
import { pitchTrack, medianFilter, countNotePlateaus, hzToNote } from '../src/analysis.js';

const b = readFileSync(process.argv[2]);
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
const samples = new Float64Array(n);
for (let i = 0; i < n; i++) {
  let a = 0;
  for (let c = 0; c < fmt.ch; c++) a += data.readInt16LE((i * fmt.ch + c) * (fmt.bits / 8)) / 32768;
  samples[i] = a / fmt.ch;
}
const { times, f0 } = pitchTrack(samples, fmt.sr);
const sm = medianFilter(f0, 15);
const T = samples.length / fmt.sr;

console.log(`${process.argv[2]}  (${T.toFixed(1)} s)`);
console.log('enter stay minDur | tónů | medián dur | <=0,4s');
for (const enter of [50, 70, 100]) {
  for (const stay of [100, 130, 200]) {
    for (const minDur of [0.15, 0.20]) {
      const p = countNotePlateaus(times, sm, { enterCents: enter, stayCents: stay, minDur });
      const durs = p.map(x => x.t1 - x.t0).sort((a, b) => a - b);
      const med = durs.length ? durs[durs.length >> 1] : 0;
      const short = durs.filter(d => d <= 0.4).length;
      console.log(`${String(enter).padStart(5)} ${String(stay).padStart(4)} ${minDur.toFixed(2).padStart(6)} | ${String(p.length).padStart(4)} | ${med.toFixed(2).padStart(10)} | ${short}`);
    }
  }
}
const best = countNotePlateaus(times, sm, { enterCents: 70, stayCents: 130, minDur: 0.20 });
console.log(`\nvybrané nastavení (70/130/0,20): ${best.length} úseků`);
console.log('t0     t1     dur   nota');
for (const p of best) console.log(`${p.t0.toFixed(2).padStart(6)} ${p.t1.toFixed(2).padStart(6)} ${(p.t1 - p.t0).toFixed(2).padStart(5)}  ${hzToNote(p.f0)}`);
