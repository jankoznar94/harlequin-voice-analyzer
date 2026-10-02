/**
 * A) Dolaď prahy na realistickém syntetickém signálu (s formanty jako hlas).
 * B) Prozkoumej rozložení SPR na skutečné nahrávce — proč ring vychází ~56 %.
 */
import { readFileSync } from 'node:fs';
import { pitchTrack, medianFilter, countNotePlateaus, analyze } from '../src/analysis.js';

const SR = 44100;
const H = (m) => 440 * Math.pow(2, (m - 69) / 12);

/* ── realistický hlas: harmonická řada × formantové rezonance ─────────── */
function voice(notes, { vibCents = 40, vibHz = 5.5 } = {}) {
  const parts = [];
  for (const [midi, dur, gap] of notes) {
    const n = Math.round(dur * SR);
    const out = new Float64Array(n);
    const ph = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = H(midi) * (1 + (vibCents / 1200) * Math.sin(2 * Math.PI * vibHz * t));
      ph[i + 1] = ph[i] + 2 * Math.PI * f / SR;
      let v = 0;
      for (let h = 1; h <= 40; h++) {
        const fh = h * f;
        if (fh > SR / 2) break;
        let a = 1 / h;
        for (const [F, BW, g] of [[700, 90, 1.6], [1150, 110, 1.0], [2600, 140, 0.8], [2900, 200, 0.9]]) {
          a += g / (1 + ((fh - F) / BW) ** 2) * (1 / h) * 2;
        }
        v += a * Math.sin(h * ph[i]);
      }
      const e = Math.min(1, t / (0.05 * dur), (dur - t) / (0.08 * dur));
      out[i] = v * Math.max(0, e) * 0.25;
    }
    parts.push(out);
    if (gap) parts.push(new Float64Array(Math.round(gap * SR)));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const sig = new Float64Array(total);
  let off = 0;
  for (const p of parts) { sig.set(p, off); off += p.length; }
  return sig;
}

const CASES = [
  ['8 not 0,8 s pauzy', [[60, .8, .25], [62, .8, .25], [64, .8, .25], [65, .8, .25], [67, .8, .25], [69, .8, .25], [71, .8, .25], [72, .8, .25]], 8],
  ['8 not 0,4 s', [[60, .4, .2], [62, .4, .2], [64, .4, .2], [65, .4, .2], [67, .4, .2], [69, .4, .2], [71, .4, .2], [72, .4, .2]], 8],
  ['8 not legato 0,7 s', [[60, .7, 0], [62, .7, 0], [64, .7, 0], [65, .7, 0], [67, .7, 0], [69, .7, 0], [71, .7, 0], [72, .7, 0]], 8],
  ['8 not legato 1,0 s', [[60, 1, 0], [62, 1, 0], [64, 1, 0], [65, 1, 0], [67, 1, 0], [69, 1, 0], [71, 1, 0], [72, 1, 0]], 8],
  ['12 not legato 0,35 s', Array.from({ length: 12 }, (_, i) => [57 + (i % 8), .35, 0]), 12],
  ['16 not 0,25 s', Array.from({ length: 16 }, (_, i) => [60 + (i % 8), .25, .08]), 16],
  ['3 držené 2,5 s', [[57, 2.5, .6], [60, 2.5, .6], [64, 2.5, .6]], 3],
  ['5 skoků o oktávu', [[48, .8, .3], [60, .8, .3], [52, .8, .3], [64, .8, .3], [55, .8, .3]], 5],
  ['6 not sestupně legato', [[72, .6, 0], [69, .6, 0], [65, .6, 0], [62, .6, 0], [60, .6, 0], [57, .6, 0]], 6],
];

const contour = {};
for (const [name, notes, exp] of CASES) {
  const sig = voice(notes);
  const { times, f0 } = pitchTrack(sig, SR);
  contour[name] = { times, sm: medianFilter(f0, 15), exp };
}

function score(opts) {
  let ok = 0, det = [];
  for (const [name, notes, exp] of CASES) {
    const { times, sm } = contour[name];
    const p = countNotePlateaus(times, sm, opts);
    if (p.length === exp) ok++; else det.push(`${name}: ${p.length}/${exp}`);
  }
  return { ok, det };
}

console.log('=== A) ladění prahů na realistickém hlasu (9 případů) ===');
let best = null;
for (const enter of [60, 70, 80, 90]) {
  for (const stay of [40, 50, 60, 70]) {
    for (const minChange of [0.04, 0.055, 0.08]) {
      for (const glide of [30, 40, 55]) {
        const opts = { enterCents: enter, stayCents: stay, minChange, glissandoCents: glide };
        const r = score(opts);
        if (!best || r.ok > best.ok) best = { ...r, opts };
      }
    }
  }
}
console.log(`nejlepší: ${best.ok}/9  ${JSON.stringify(best.opts)}`);
if (best.det.length) console.log('  chyby: ' + best.det.join(' | '));
const def = score({});
console.log(`výchozí (70/50/0,055/40): ${def.ok}/9`);
if (def.det.length) console.log('  chyby: ' + def.det.join(' | '));

/* ── B) rozložení SPR na skutečné nahrávce ───────────────────────────── */
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
const spr = res.notes.map(n => n.spr).filter(v => v === v).sort((a, b) => a - b);
const hist = {};
for (const v of spr) { const k = Math.floor(v / 2) * 2; hist[k] = (hist[k] || 0) + 1; }
console.log('\n=== B) rozložení SPR (tóny, 2dB koše) ===');
for (const k of Object.keys(hist).map(Number).sort((a, b) => a - b)) {
  console.log(`  ${String(k).padStart(4)} dB  ${'#'.repeat(hist[k])} ${hist[k]}`);
}
const med = res.summary.spr_median, thr = res.summary.ring_threshold;
console.log(`\n  medián ${med.toFixed(2)} dB, práh ringu ${thr.toFixed(2)} dB, SD ${res.summary.spr_sd.toFixed(2)}`);
console.log(`  tónů ${spr.length}, z toho pod prahem ${spr.filter(v => v < thr).length}`);
console.log(`  rozpětí ${spr[0].toFixed(1)} … ${spr[spr.length - 1].toFixed(1)} dB`);

// kde jsou tóny s nízkým SPR v čase?
const low = res.notes.filter(n => n.spr === n.spr && n.spr < thr);
const hi = res.notes.filter(n => n.spr === n.spr && n.spr >= thr);
const avg = (a, f) => a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : 0;
console.log(`\n  tóny s ringem:    SPL ${avg(hi, n => n.spl_dbfs).toFixed(1)} dBFS, dur ${avg(hi, n => n.dur).toFixed(2)} s, f0 ${avg(hi, n => n.f0).toFixed(0)} Hz`);
console.log(`  tóny bez ringu:   SPL ${avg(low, n => n.spl_dbfs).toFixed(1)} dBFS, dur ${avg(low, n => n.dur).toFixed(2)} s, f0 ${avg(low, n => n.f0).toFixed(0)} Hz`);
console.log(`  bez ringu v čase: ${low.map(n => n.t_start.toFixed(0)).join(' ')}`);
