import { readFileSync } from 'node:fs';
import { pitchTrack, hzToNote, hzToCents } from '../src/analysis.js';

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

const [, , wavPath] = process.argv;
const { samples, sampleRate } = loadWav(wavPath);
const { times, f0 } = pitchTrack(samples, sampleRate);

/* ── Kvalitativní přehled: 0,1s okna, mediánová výška ────────────────── */
const WIN = 0.1, HOP = 0.1;
const T = samples.length / sampleRate;
const rows = [];
for (let t = 0; t + WIN <= T; t += HOP) {
  const v = [];
  for (let i = 0; i < f0.length; i++) {
    if (times[i] >= t && times[i] < t + WIN && f0[i] > 0) v.push(f0[i]);
  }
  if (v.length < 2) { rows.push([t, 0]); continue; }
  v.sort((a, b) => a - b);
  rows.push([t, v[v.length >> 1]]);
}

/* Rozděl na "úseky znělosti" a v každém sleduj stabilní plató. */
console.log('čas    nota   Hz    pozn');
let curNote = null, curStart = 0, curVals = [];
const plateaus = [];
function flush(endT) {
  if (curVals.length >= 3 && endT - curStart >= 0.2) {
    const s = [...curVals].sort((a, b) => a - b);
    plateaus.push({ t0: curStart, t1: endT, f0: s[s.length >> 1], note: hzToNote(s[s.length >> 1]) });
  }
  curVals = [];
}
for (const [t, f] of rows) {
  if (!(f > 0)) { flush(t); curNote = null; continue; }
  const n = hzToNote(f);
  if (curNote === null) { curNote = n; curStart = t; curVals = [f]; continue; }
  if (n === curNote) { curVals.push(f); continue; }
  // změna noty — ale jen když drží (jinak je to přechod)
  const dist = Math.abs(hzToCents(f) - hzToCents(curVals[curVals.length - 1]));
  if (dist > 60) { flush(t); curNote = n; curStart = t; curVals = [f]; }
  else curVals.push(f);
}
flush(T);

console.log(`\ncelková délka ${T.toFixed(1)} s, znělých 0,1s oken: ${rows.filter(r => r[1] > 0).length}`);
console.log(`plató (notových úseků) s trváním >= 0,2 s: ${plateaus.length}\n`);
console.log('t0      t1      dur    nota   f0 Hz');
for (const p of plateaus) {
  console.log(`${p.t0.toFixed(2).padStart(6)}  ${p.t1.toFixed(2).padStart(6)}  ${(p.t1 - p.t0).toFixed(2).padStart(5)}  ${p.note.padEnd(5)}  ${p.f0.toFixed(1).padStart(7)}`);
}
