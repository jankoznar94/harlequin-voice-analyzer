/** Detaily 4 výpadků + rozložení not + závislost SPR na délce tónu. */
import { readFileSync } from 'node:fs';
import { analyze, hzToNote } from '../src/analysis.js';

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
const smp = new Float64Array(N);
for (let i = 0; i < N; i++) {
  let a = 0;
  for (let c = 0; c < fmt.ch; c++) a += data.readInt16LE((i * fmt.ch + c) * (fmt.bits / 8)) / 32768;
  smp[i] = a / fmt.ch;
}
const res = analyze(smp, fmt.sr, { fach: 'tenor' });
const s = res.summary;

console.log('=== 4 výpadky ringu ===');
for (const d of s.dropouts) {
  const n = res.notes.find(x => x.t_start === d.t);
  console.log(`  ${d.note.padEnd(5)} ${d.t.toFixed(1)} s  délka ${d.dur.toFixed(2)} s  SPR ${d.spr.toFixed(1)} dB  SPL ${d.spl.toFixed(1)} dBFS  rozkmit ${n?.span_cents?.toFixed(0)} centů`);
}

console.log('\n=== rozložení not (nad Es4 = 311 Hz by nic být nemělo) ===');
const byNote = {};
for (const n of res.notes) byNote[n.note] = (byNote[n.note] || 0) + 1;
const order = ['C3','C#3','D3','D#3','E3','F3','F#3','G3','G#3','A3','A#3','B3','C4','C#4','D4','D#4','E4','F4','F#4','G4','G#4','A4','A#4','B4','C5'];
let above = 0;
for (const nm of order) {
  if (!byNote[nm]) continue;
  const isAbove = nm.endsWith('4') && 'F G G# A A# B C5'.split(' ').some(x => nm === x);
  if (isAbove) above += byNote[nm];
  console.log(`  ${nm.padEnd(4)} ${String(byNote[nm]).padStart(3)} ${'#'.repeat(byNote[nm])}`);
}
console.log(`  → nad Es4: ${above} z ${res.notes.length} tónů`);

console.log('\n=== SPR podle délky tónu (je měření na krátkých tónech spolehlivé?) ===');
const buckets = [[0, .3], [.3, .45], [.45, .6], [.6, .9], [.9, 10]];
for (const [lo, hi] of buckets) {
  const g = res.notes.filter(n => n.dur >= lo && n.dur < hi && n.spr === n.spr);
  if (g.length < 2) { console.log(`  ${lo}–${hi} s: ${g.length} tónů (málo)`); continue; }
  const vals = g.map(n => n.spr);
  const mean = vals.reduce((a, x) => a + x, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, x) => a + (x - mean) ** 2, 0) / vals.length);
  const sorted = [...vals].sort((a, b) => a - b);
  const mad = (() => { const d = vals.map(v => Math.abs(v - sorted[sorted.length >> 1])).sort((a, b) => a - b); return d[d.length >> 1]; })();
  console.log(`  ${String(lo).padEnd(4)}–${String(hi).padEnd(4)} s: ${String(g.length).padStart(3)} tónů | SPR medián ${sorted[sorted.length >> 1].toFixed(1).padStart(6)} dB | rozptyl SD ${sd.toFixed(2)}, MAD ${mad.toFixed(2)}`);
}

console.log('\n=== kolik tónů je kratších než 0,3 s (pod hranicí spolehlivosti SPR) ===');
const short = res.notes.filter(n => n.dur < 0.3);
console.log(`  ${short.length} z ${res.notes.length} tónů`);
console.log(`  jejich SPR medián: ${short.map(n => n.spr).filter(v => v === v).sort((a, b) => a - b)[Math.floor(short.length / 2)]?.toFixed(1) ?? '—'} dB`);
