/** Hledání prahů, které projdou všemi ground-truth případy. */
import { pitchTrack, medianFilter, countNotePlateaus } from '../src/analysis.js';

const SR = 44100;
const H = (m) => 440 * Math.pow(2, (m - 69) / 12);

function note(f0, dur, env = { rise: 0.05, fall: 0.08 }) {
  const n = Math.round(dur * SR);
  const out = new Float64Array(n);
  const ph = new Float64Array(n + 1);
  const vib = env.vibrato ?? 40;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 * (1 + (vib / 1200) * Math.sin(2 * Math.PI * 5.5 * t));
    ph[i + 1] = ph[i] + 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h <= 30; h++) { if (h * f > SR / 2) break; v += (1 / h) * Math.sin(h * ph[i]); }
    const e = Math.min(1, t / (env.rise * dur), (dur - t) / (env.fall * dur));
    out[i] = v * Math.max(0, e) * 0.25;
  }
  return out;
}

function seq(notes) {
  const parts = [];
  for (const [midi, dur, gap] of notes) {
    parts.push(note(H(midi), dur));
    if (gap) parts.push(new Float64Array(Math.round(gap * SR)));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float64Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const cases = [
  ['8 not 0,8 s + pauzy', seq([60, 62, 64, 65, 67, 69, 71, 72].map(m => [m, 0.8, 0.25])), 8],
  ['8 not 0,4 s', seq([60, 62, 64, 65, 67, 69, 71, 72].map(m => [m, 0.4, 0.2])), 8],
  ['8 not legato 0,7 s', seq([60, 62, 64, 65, 67, 69, 71, 72].map(m => [m, 0.7, 0])), 8],
  ['8 not legato 1,0 s', seq([60, 62, 64, 65, 67, 69, 71, 72].map(m => [m, 1.0, 0])), 8],
  ['3 držené 2,5 s', seq([[57, 2.5, 0.6], [60, 2.5, 0.6], [64, 2.5, 0.6]]), 3],
  ['5 skoků o oktávu', seq([[48, 0.8, 0.3], [60, 0.8, 0.3], [52, 0.8, 0.3], [64, 0.8, 0.3], [55, 0.8, 0.3]]), 5],
  ['16 not 0,25 s', seq(Array.from({ length: 16 }, (_, i) => [60 + (i % 8), 0.25, 0.08])), 16],
  ['12 not 0,35 s legato', seq(Array.from({ length: 12 }, (_, i) => [57 + (i % 8), 0.35, 0])), 12],
  ['4 noty + doprovod', (() => {
    const m = seq([[60, 0.8, 0.25], [64, 0.8, 0.25], [67, 0.8, 0.25], [72, 0.8, 0.25]]);
    for (let i = 0; i < m.length; i++) {
      const t = i / SR;
      m[i] += (Math.sin(2 * Math.PI * H(36) * t) + 0.6 * Math.sin(2 * Math.PI * H(43) * t)) * 0.06 * Math.exp(-((t % 1.05)) * 2);
    }
    return m;
  })(), 4],
];

function score(opts) {
  let ok = 0;
  for (const [, sig, exp] of cases) {
    const { times, f0 } = pitchTrack(sig, SR);
    const sm = medianFilter(f0, 15);
    const p = countNotePlateaus(times, sm, opts);
    if (p.length === exp) ok++;
  }
  return ok;
}

// kontura se počítá pro každý případ jen jednou
function evalOpts(opts) {
  const det = [];
  for (const [name, sig, exp] of cases) {
    const { times, f0 } = pitchTrack(sig, SR);
    const sm = medianFilter(f0, 15);
    const p = countNotePlateaus(times, sm, opts);
    det.push(`${name}: ${p.length}/${exp}`);
  }
  return det;
}

console.log('hledám prahy, které projdou všemi 9 případy...\n');
let best = null;
for (const enter of [70, 90, 110]) {
  for (const stay of [50, 65, 80]) {
    for (const minChange of [0.055, 0.08, 0.11]) {
      for (const glide of [40, 55, 80]) {
        const opts = { enterCents: enter, stayCents: stay, minChange, glissandoCents: glide };
        const s = score(opts);
        if (!best || s > best.s) best = { s, opts };
      }
    }
  }
}
console.log('nejlepší nalezené:', best.s + '/9', JSON.stringify(best.opts));
console.log('detail:');
for (const d of evalOpts(best.opts)) console.log('  ' + d);
console.log('\nvýchozí (90/65/0,055/55):', score({}) + '/9');
for (const d of evalOpts({})) console.log('  ' + d);
