/**
 * Proč vychází ring ~56 %? Zkoumá vztah SPR k hlasitosti, délce a výšce tónu
 * a testuje pravidla, která z hodnocení vyloučí tóny, na kterých SPR nic neznamená.
 */
import { readFileSync } from 'node:fs';
import { analyze } from '../src/analysis.js';

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
const notes = res.notes.filter(n => n.spr === n.spr);

/* ── korelace SPR vs SPL / délka / výška ─────────────────────────────── */
function corr(xs, ys) {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
const spr = notes.map(n => n.spr);
console.log(`tónů celkem ${notes.length}`);
console.log(`korelace SPR vs SPL (hlasitost) : r = ${corr(spr, notes.map(n => n.spl_dbfs)).toFixed(3)}`);
console.log(`korelace SPR vs délka tónu      : r = ${corr(spr, notes.map(n => n.dur)).toFixed(3)}`);
console.log(`korelace SPR vs f0 (výška)      : r = ${corr(spr, notes.map(n => n.f0)).toFixed(3)}`);

/* ── SPL podle SPR ───────────────────────────────────────────────────── */
const buckets = [[-Infinity, -30], [-30, -25], [-25, -20], [-20, -15], [-15, 0]];
console.log('\nSPL (dBFS) podle pásma SPR:');
for (const [lo, hi] of buckets) {
  const g = notes.filter(n => n.spr >= lo && n.spr < hi);
  if (!g.length) continue;
  const avg = (f) => g.reduce((s, x) => s + f(x), 0) / g.length;
  console.log(`  SPR ${String(lo).padStart(5)}…${String(hi).padStart(4)} dB: ${String(g.length).padStart(3)} tónů | SPL ${avg(n => n.spl_dbfs).toFixed(1)} dBFS | délka ${avg(n => n.dur).toFixed(2)} s | f0 ${avg(n => n.f0).toFixed(0)} Hz`);
}

/* ── pravidla vyloučení ──────────────────────────────────────────────── */
const medSpl = (() => { const v = notes.map(n => n.spl_dbfs).sort((a, b) => a - b); return v[v.length >> 1]; })();
console.log(`\nmedián SPL nahrávky: ${medSpl.toFixed(1)} dBFS`);
const THR = -20.0;   // literární práh (Omori)

function ringPct(filt) {
  const use = notes.filter(filt);
  if (!use.length) return null;
  const ok = use.filter(n => n.spr >= THR).length;
  return { n: use.length, ok, pct: 100 * ok / use.length };
}
const rules = [
  ['nic nevylučovat (nyní)', () => true],
  ['délka >= 0,30 s', n => n.dur >= 0.30],
  ['délka >= 0,40 s', n => n.dur >= 0.40],
  ['SPL do 20 dB od mediánu', n => n.spl_dbfs >= medSpl - 20],
  ['SPL do 12 dB od mediánu', n => n.spl_dbfs >= medSpl - 12],
  ['SPL do 20 dB + délka >= 0,30 s', n => n.spl_dbfs >= medSpl - 20 && n.dur >= 0.30],
  ['SPL do 20 dB + délka >= 0,40 s', n => n.spl_dbfs >= medSpl - 20 && n.dur >= 0.40],
  ['SPL do 15 dB + délka >= 0,35 s', n => n.spl_dbfs >= medSpl - 15 && n.dur >= 0.35],
  ['jen držené (délka >= 0,5 s)', n => n.dur >= 0.50],
];
console.log('\npravidlo                              tónů  s ringem   %');
for (const [name, f] of rules) {
  const r = ringPct(f);
  console.log(`  ${name.padEnd(34)} ${String(r.n).padStart(4)}  ${String(r.ok).padStart(6)}  ${r.pct.toFixed(1).padStart(6)} %`);
}

/* ── přežije verdikt změnu prahu? ────────────────────────────────────── */
console.log('\ncitlivost na prah ringu (jen tóny SPL do 20 dB od mediánu a délka >= 0,35 s):');
const use = notes.filter(n => n.spl_dbfs >= medSpl - 20 && n.dur >= 0.35);
for (const thr of [-24, -22, -20, -18, -16, -14]) {
  const ok = use.filter(n => n.spr >= thr).length;
  console.log(`  práh ${String(thr).padStart(4)} dB → ${String(ok).padStart(3)}/${use.length}  ${(100 * ok / use.length).toFixed(1)} %`);
}
// rozdělení SPR v této vyčištěné sadě
const s2 = use.map(n => n.spr).sort((a, b) => a - b);
console.log(`\nvyčištěná sada: ${use.length} tónů, SPR medián ${s2[s2.length >> 1].toFixed(2)} dB, SD ${(Math.sqrt(s2.reduce((a, x) => a + (x - s2.reduce((p, q) => p + q, 0) / s2.length) ** 2, 0) / s2.length)).toFixed(2)}, rozpětí ${s2[0].toFixed(1)}…${s2[s2.length - 1].toFixed(1)}`);
