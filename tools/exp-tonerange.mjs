/**
 * Árie jde jen do Es4 (311 Hz). Cokoli nad tím je CHYBA SLEDOVÁNÍ VÝŠKY,
 * ne skutečný tón. Kolik takových je a dá se to opravit?
 */
import { readFileSync } from 'node:fs';
import { pitchTrack, medianFilter, countNotePlateaus, hzToNote, hzToCents } from '../src/analysis.js';

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
const N = Math.floor(data.length / (fmt.ch * fmt.bits / 8));
const samples = new Float64Array(N);
for (let i = 0; i < N; i++) {
  let a = 0;
  for (let c = 0; c < fmt.ch; c++) a += data.readInt16LE((i * fmt.ch + c) * (fmt.bits / 8)) / 32768;
  samples[i] = a / fmt.ch;
}
const SR = fmt.sr;
const ES4 = 311.13;

const { times, f0 } = pitchTrack(samples, SR);
const sm = medianFilter(f0, 15);
const p = countNotePlateaus(times, sm, {});

console.log(`Es4 = ${ES4} Hz. Detekováno ${p.length} tónových úseků.\n`);
const above = p.filter(x => x.f0 > ES4 * 1.03);
console.log(`úseků NAD Es4: ${above.length}`);
for (const x of above) {
  // co je o oktávu níž?
  const half = x.f0 / 2;
  console.log(`  ${x.t0.toFixed(1)}–${x.t1.toFixed(1)} s  ${hzToNote(x.f0)} (${x.f0.toFixed(0)} Hz)  → /2 = ${hzToNote(half)} (${half.toFixed(0)} Hz)  dur ${(x.t1 - x.t0).toFixed(2)} s  rozkmit ${x.spanCents.toFixed(0)} centů`);
}

/* Kolik rámců kontury leží nad Es4 a má přitom o oktávu níž silného souseda? */
let nAbove = 0, nFixable = 0;
for (let i = 0; i < f0.length; i++) {
  if (!(sm[i] > ES4 * 1.03)) continue;
  nAbove++;
  const lo = sm[i] / 2;
  const a = Math.max(0, i - 40), bb = Math.min(f0.length, i + 41);
  let near = 0;
  for (let j = a; j < bb; j++) if (sm[j] > 0 && Math.abs(hzToCents(sm[j]) - hzToCents(lo)) < 60) near++;
  if (near >= 4) nFixable++;
}
console.log(`\nrámců kontury nad Es4: ${nAbove}, z toho s podporou o oktávu níž: ${nFixable}`);

/* Podívej se na konkrétní místa */
for (const t of [above[0]?.t0, 74.2, 113.0]) {
  if (t === undefined) continue;
  console.log(`\n--- kontura kolem ${t.toFixed(1)} s ---`);
  for (let i = 0; i < f0.length; i++) {
    if (times[i] < t - 0.5 || times[i] > t + 0.5) continue;
    if (i % 4) continue;
    console.log(`  ${times[i].toFixed(2)}  ${sm[i] > 0 ? hzToNote(sm[i]).padEnd(4) + sm[i].toFixed(1).padStart(7) : '—'}`);
  }
}

/* rozložení not podle výšky */
const byNote = {};
for (const x of p) byNote[hzToNote(x.f0)] = (byNote[hzToNote(x.f0)] || 0) + 1;
console.log('\n=== rozložení tónů podle noty (počet) ===');
const order = ['C3', 'C#3', 'D3', 'D#3', 'E3', 'F3', 'F#3', 'G3', 'G#3', 'A3', 'A#3', 'B3', 'C4', 'C#4', 'D4', 'D#4', 'E4', 'F4', 'F#4', 'G4', 'G#4', 'A4', 'A#4', 'B4', 'C5', 'C#5'];
for (const n of order) if (byNote[n]) console.log(`  ${n.padEnd(4)} ${String(byNote[n]).padStart(3)}  ${'#'.repeat(byNote[n])}`);
