#!/usr/bin/env node
/**
 * DIAGNOSTIKA: rozdíl živě vs report u melodie — rozpad po TÓNECH.
 *
 * Zjištěno: filtr na ustálené/hlasité rámce rozdíl nezmění (346 → 335 rámců),
 * takže náběhy a doznívání to nejsou. Rozdíl musí být v tom, JAK se z hodnot
 * dělá souhrn:
 *   report — MEDIÁN PŘES TÓNY (každý tón jedno číslo, stejná váha)
 *   živě   — MEDIÁN PŘES RÁMCE (delší tón = víc rámců = větší váha)
 * U melodie, kde tóny mají různou výšku a tím i různou SPR, se obojí musí
 * rozejít. Otázka je, které číslo je blíž PRAVDĚ.
 *
 * Použití: node tools/diag-live-melody2.mjs
 */
import { sprFrames, analyze, SprCore } from '../src/analysis.js';
import { createLiveState, feedFrame, BLOCK_MS, FRAME_SIZE } from '../src/live.js';
import { createDsp } from '../src/dsp-backend.js';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const WASM = path.join(ROOT, 'wasm', 'build', 'dsp.wasm');
const SR = 48000, HOP = Math.round(SR * BLOCK_MS / 1000);
const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const gainOf = (f) => {
  let a = 0.02;
  for (const [fc, bw, g] of [[700, 80, 1.0], [1200, 110, 0.55], [2600, 180, 0.35]]) a += g / (1 + ((f - fc) / bw) ** 2);
  return a;
};
function tone(f0, dur, { vibDepth = 0, seed = 5 } = {}) {
  const n = Math.round(SR * dur), out = new Float64Array(n), rnd = mulberry32(seed);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = f0 * (1 + vibDepth * Math.sin(2 * Math.PI * 5.5 * i / SR));
    ph += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h * f0 < 5200; h++) v += gainOf(h * f0) * Math.sin(ph * h) / Math.sqrt(h);
    const env = Math.min(1, i / (SR * 0.05)) * Math.min(1, (n - i) / (SR * 0.10));
    out[i] = 0.28 * v * env + (rnd() - 0.5) * 3e-4;
  }
  return out;
}
function melody(f0s, dur = 1.4) {
  const parts = [], spans = [];
  let t = 0;
  for (let i = 0; i < f0s.length; i++) {
    const tn = tone(f0s[i], dur, { vibDepth: 0.025, seed: 5 + i });
    parts.push(tn); spans.push([t, t + dur, f0s[i]]);
    t += dur;
    const gap = new Float64Array(Math.round(SR * 0.25));
    parts.push(gap); t += 0.25;
  }
  const out = new Float64Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return { sig: out, spans };
}
function trueSPR(f0) {
  let lo = 0, hi = 0;
  for (let h = 1; h * f0 < 5200; h++) {
    const f = h * f0, a = gainOf(f) / Math.sqrt(h);
    if (f < 2000) lo = Math.max(lo, a);
    if (f >= 2000 && f <= 4000) hi = Math.max(hi, a);
  }
  return (lo && hi) ? 20 * Math.log10(hi / lo) : NaN;
}

const { sig, spans } = melody([196, 247, 294, 330, 392]);

// 1. report: co našel za tóny a jaká čísla
const res = analyze(sig, SR, { fach: 'tenor' });
console.log('\nREPORT (spr_novy_median = ' + res.summary.spr_novy_median?.toFixed(2) + '):');
for (const n of res.notes) {
  console.log(`  ${n.note.padEnd(4)} ${n.t_start.toFixed(2)}–${n.t_end.toFixed(2)} s  `
    + `spr_novy ${Number.isFinite(n.spr_novy) ? n.spr_novy.toFixed(2) : '—'}  `
    + `pravda ${trueSPR(n.f0).toFixed(2)}`);
}

// 2. živá simulace: rámce s časem
const dsp = await createDsp({ frameSize: FRAME_SIZE, sampleRate: SR, fach: 'tenor', wasmUrl: WASM });
const core = new SprCore(SR, 4096);
let pending = new Float64Array(0);
const recs = [];
for (let b = 0; b + HOP <= sig.length; b += HOP) {
  const merged = new Float64Array(pending.length + HOP);
  merged.set(pending, 0); merged.set(sig.subarray(b, b + HOP), pending.length);
  let off = 0;
  while (merged.length - off >= FRAME_SIZE) {
    const end = off + FRAME_SIZE;
    const f0 = dsp.process(merged.subarray(off, end));
    const rms = dsp.rms(merged.subarray(off, end));
    const spr = core.of(merged.subarray(Math.max(0, end - 4096), end));
    recs.push({ t: (b + off) / SR, f0, dbfs: 20 * Math.log10(rms || 1e-12), spr });
    off += HOP;
  }
  pending = merged.slice(off);
}
const voiced = recs.filter(r => r.f0 > 0 && Number.isFinite(r.spr) && r.dbfs > -40);
console.log('\nŽIVĚ (medián přes rámce = ' + median(voiced.map(r => r.spr)).toFixed(2) + '), rozpad po tónech:');

const perTone = [];
for (const [t0, t1, f0] of spans) {
  const inside = voiced.filter(r => r.t >= t0 + 0.15 && r.t <= t1 - 0.15);
  const m = median(inside.map(r => r.spr));
  perTone.push(m);
  console.log(`  ${f0} Hz  rámců ${String(inside.length).padStart(3)}  `
    + `živě medián ${Number.isFinite(m) ? m.toFixed(2) : '—'}  pravda ${trueSPR(f0).toFixed(2)}`);
}
console.log(`\nmedián přes tóny (živé hodnoty): ${median(perTone).toFixed(2)}`);
console.log(`medián přes tóny (pravda):       ${median(spans.map(s => trueSPR(s[2]))).toFixed(2)}`);
console.log(`report:                          ${res.summary.spr_novy_median?.toFixed(2)}`);
console.log(`živě přes rámce:                 ${median(voiced.map(r => r.spr)).toFixed(2)}`);
console.log('\nHotovo.');
