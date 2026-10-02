/** Experiment: jaký dopad má šířka okna pro opravu oktáv a prahy segmentace. */
import { readFileSync } from 'node:fs';
import { pitchTrack, medianFilter, segmentNotes, hzToNote, hzToCents, fixOctaveErrors } from '../src/analysis.js';

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

/* Kolik tónů napočítá "naivní" čítač plató (hystereze ±35 centů, min 0,25 s)? */
function countPlateaus(f0v, { minDur = 0.25, enter = 50, stay = 90 } = {}) {
  let cur = 0, n = 0, runStart = 0, lastOk = 0;
  for (let i = 0; i < f0v.length; i++) {
    const f = f0v[i];
    if (!(f > 0)) { if (cur && times[lastOk] - times[runStart] >= minDur) n++; cur = 0; continue; }
    const c = hzToCents(f);
    if (!cur) { cur = c; runStart = i; lastOk = i; continue; }
    if (Math.abs(c - cur) <= (Math.abs(c - cur) <= stay ? stay : enter)) { cur = 0.7 * cur + 0.3 * c; lastOk = i; }
    else { if (times[lastOk] - times[runStart] >= minDur) n++; cur = c; runStart = i; lastOk = i; }
  }
  if (cur && times[lastOk] - times[runStart] >= minDur) n++;
  return n;
}

console.log('verze                    tónů  segmentace(0,3s)  segmentace(0,5s)');
const raw = Float64Array.from(f0);
const variants = {
  'žádná oprava': raw,
  'oktávy okno 12 (120 ms)': fixOctaveErrors(raw, 12),
  'oktávy okno 30 (300 ms)': fixOctaveErrors(raw, 30),
  'oktávy okno 60 (600 ms)': fixOctaveErrors(raw, 60),
  'oktávy okno 100 (1 s)': fixOctaveErrors(raw, 100),
};
for (const [name, v] of Object.entries(variants)) {
  const c = countPlateaus(v);
  const s1 = segmentNotes(times, v, { minDur: 0.3 }).length;
  const s2 = segmentNotes(times, v, { minDur: 0.5 }).length;
  console.log(name.padEnd(26), String(c).padStart(4), String(s1).padStart(14), String(s2).padStart(16));
}

console.log('\nkontrola oblasti 15,1-17,0 s (okno 60):');
const v60 = fixOctaveErrors(raw, 60);
for (let i = 0; i < f0.length; i += 8) {
  if (times[i] < 14.8 || times[i] > 17.2) continue;
  console.log(times[i].toFixed(2), 'raw', f0[i] > 0 ? hzToNote(f0[i]) : '—', ' fix', v60[i] > 0 ? hzToNote(v60[i]) : '—');
}
