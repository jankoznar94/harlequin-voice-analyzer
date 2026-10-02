/** Analýza s oborem bariton + kontrola úrovně v prvních 7 sekundách. */
import { readFileSync } from 'node:fs';
import { analyze, pitchTrack, hzToNote, czPlural } from '../src/analysis.js';

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
const SR = fmt.sr;

/* úroveň po sekundách v prvních 12 s */
console.log('=== úroveň (RMS dBFS) po sekundách, prvních 12 s ===');
for (let t = 0; t < 12; t++) {
  const i0 = Math.round(t * SR), i1 = Math.min(N, Math.round((t + 1) * SR));
  let rms = 0, peak = 0;
  for (let i = i0; i < i1; i++) { rms += smp[i] * smp[i]; peak = Math.max(peak, Math.abs(smp[i])); }
  rms = Math.sqrt(rms / Math.max(1, i1 - i0));
  const dbfs = 20 * Math.log10(rms + 1e-12);
  const bar = '#'.repeat(Math.max(0, Math.round((dbfs + 70) / 2)));
  console.log(`  ${String(t).padStart(2)} s  ${dbfs.toFixed(1).padStart(6)} dBFS  peak ${peak.toFixed(3)}  ${bar}`);
}

/* rozložení úrovně celé nahrávky */
let rmsAll = 0;
for (let i = 0; i < N; i++) rmsAll += smp[i] * smp[i];
console.log(`\ncelková RMS: ${(20 * Math.log10(Math.sqrt(rmsAll / N) + 1e-12)).toFixed(1)} dBFS`);
let ticho = 0;
for (let i = 0; i < N; i += 441) { // po 10 ms
  if (Math.abs(smp[i]) < 0.001) ticho++;
}
console.log(`vzorků pod 0,001 (−60 dBFS): ${(100 * ticho / Math.round(N / 441)).toFixed(1)} %`);

/* analýza pro oba obory */
for (const fach of ['tenor', 'bariton']) {
  const res = analyze(smp, SR, { fach });
  const s = res.summary;
  const notes = res.notes;
  console.log(`\n═══ obor ${fach} ═══`);
  console.log(`tónů ${res.n_notes} (vyřazeno ${res.n_dropped})`);
  console.log(`rozsah tónů: ${notes[0]?.note} … ${notes[notes.length - 1]?.note}`);
  const lo = Math.min(...notes.map(n => n.f0)), hi = Math.max(...notes.map(n => n.f0));
  console.log(`f0 od ${lo.toFixed(0)} do ${hi.toFixed(0)} Hz (${hzToNote(lo)} … ${hzToNote(hi)})`);
  if (!s.spr_unusable) {
    console.log(`vyrovnanost ${s.ring_consistency_pct.toFixed(1)} % (${s.notes_with_ring}/${s.n_notes}), výpadků ${s.dropouts.length}`);
    console.log(`SPR medián ${s.spr_median.toFixed(2)} dB, úroveň: ${s.level} (nad −20 dB ${s.pct_above_ref.toFixed(0)} %)`);
    console.log(`FHE medián ${Math.round(s.fhe_median)} Hz (ref. bariton 2454 ± 206)`);
    console.log(`ladění od G4: ${s.f1_aligned_pct === null ? '— (žádný tón od G4, správně)' : s.f1_aligned_pct.toFixed(0) + ' %'}`);
    if (s.dropouts.length) console.log(`výpadky: ${s.dropouts.map(d => `${d.note}@${d.t.toFixed(0)}s`).join(', ')}`);
  }
}

/* rozložení délek tónů — u melodie jsou noty kratší než u cvičení */
const res = analyze(smp, SR, { fach: 'bariton' });
const durs = res.notes.map(n => n.dur).sort((a, b) => a - b);
console.log('\n=== délky tónů (melodie) ===');
const q = (p) => durs[Math.floor(p * (durs.length - 1))];
console.log(`  min ${durs[0].toFixed(2)} s | 25 % ${q(0.25).toFixed(2)} | medián ${q(0.5).toFixed(2)} | 75 % ${q(0.75).toFixed(2)} | max ${durs[durs.length - 1].toFixed(2)} s`);
console.log(`  tónů kratších než 0,4 s: ${durs.filter(d => d < 0.4).length} z ${durs.length}`);
