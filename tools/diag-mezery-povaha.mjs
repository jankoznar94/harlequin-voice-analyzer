#!/usr/bin/env node
/* Jak vypadají mezery v grafu na reálné nahrávce — je v nich signál, nebo ticho?
 *
 * Pro každou mezeru (místo, kde není změřený tón) vypíše max RMS v okně 2048,
 * podíl rámců pod prahem a jestli tam YIN výšku našel. Tím se oddělí
 * „skutečná pauza ve zpěvu" od „signál tam je a výška se nenašla".
 */
import { execFileSync } from 'node:child_process';
import { analyze, pitchTrack } from '../src/analysis.js';

const SRC = process.argv[2] || 'rec-test/zpev.wav';
const RATE = 48000;
const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', SRC, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
const n = Math.floor(pcm.length / 4);
const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
const x = new Float64Array(n);
for (let i = 0; i < n; i++) x[i] = dv.getFloat32(i * 4, true);

const r = analyze(x, RATE, { fach: 'tenor', fileRate: NaN });
const pt = pitchTrack(x, RATE, {});
const hop = Math.round(0.010 * RATE);
const FS = 2048, RMS_MIN = 0.008;

const rmsAt = (t) => {
  const s = Math.round(t * RATE);
  let s2 = 0;
  for (let j = s; j < Math.min(x.length, s + FS); j++) s2 += x[j] * x[j];
  return Math.sqrt(s2 / FS);
};
const f0At = (t) => {
  const i = Math.round(t * RATE / hop);
  return i >= 0 && i < pt.f0.length ? pt.f0[i] : 0;
};

console.log(`soubor ${SRC} · ${r.duration_s.toFixed(1)} s · ${r.n_notes} tónů · dropped ${r.dropped.length}`);
console.log('dropped:', r.dropped.map(d => `${d.why} ${d.t0.toFixed(1)}–${d.t1.toFixed(1)}`).join(' | ') || '—');

const segs = [...r.notes].sort((a, b) => a.t_start - b.t_start);
const gaps = [];
let t = 0;
for (const s of segs) {
  if (s.t_start - t > 0.6) gaps.push([t, s.t_start]);
  t = Math.max(t, s.t_end);
}
if (r.duration_s - t > 0.6) gaps.push([t, r.duration_s]);

console.log(`\nmezery (>0,6 s): ${gaps.length}`);
console.log('  od–do (s)      délka  maxRMS(dB)  %pod prahem   výška?   verdikt');
for (const [a, b] of gaps) {
  let mx = 0, under = 0, cnt = 0, withF0 = 0;
  for (let tt = a; tt < b; tt += 0.01) {
    const rr = rmsAt(tt); cnt++;
    if (rr > mx) mx = rr;
    if (rr < RMS_MIN) under++;
    if (f0At(tt) > 0) withF0++;
  }
  const db = 20 * Math.log10(mx + 1e-12);
  const verdikt = mx < RMS_MIN ? 'TICHO (pauza)'
    : withF0 > cnt * 0.1 ? 'výška nalezena — segmentace ji nedala do tónu'
      : 'SIGNÁL bez výšky (YIN nenašel)';
  console.log(`  ${a.toFixed(1).padStart(6)}–${b.toFixed(1).toString().padEnd(6)} ${(b - a).toFixed(1).padStart(5)}  ${db.toFixed(1).padStart(9)}  ${(100 * under / cnt).toFixed(0).padStart(8)} %  ${(100 * withF0 / cnt).toFixed(0).padStart(5)} %   ${verdikt}`);
}
