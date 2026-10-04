#!/usr/bin/env node
/**
 * EXPERIMENT: proč u MELODIE vychází živé číslo o ~2 dB níž než report?
 *
 * U drženého tónu sedí živá cesta s reportem na 0,01–0,5 dB. U melodie je
 * rozdíl ~2 dB, a to se nesmí nechat neobjasněné — jinak by se „opravené"
 * číslo u fráze rozešlo s reportem znovu.
 *
 * Podezření: nejde o měřidlo, ale o to, CO se zprůměruje.
 *   report — medián přes TÓNY, a každý tón je p90 z jeho VNITŘKU (20 % okrajů
 *            se vynechává), takže náběhy a doznívání do čísla nevstupují
 *   živě   — medián přes RÁMCE; náběh a doznívání tónu jsou taky rámce
 *
 * Měří se tři varianty živého souhrnu:
 *   všechny rámce             (dnešní stav)
 *   jen ustálené rámce       (výška se drží ≥ 3 rámce)
 *   jen rámce nad prahem hlasitosti (relativně, jako filtr v ringAnalysis)
 *
 * Použití: node tools/exp-live-steady.mjs
 */
import { sprFrames, analyze, SprCore, percentile } from '../src/analysis.js';
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
function tone(f0, dur, { vibDepth = 0, seed = 5 } = {}) {
  const n = Math.round(SR * dur), out = new Float64Array(n), rnd = mulberry32(seed);
  const gain = (f) => {
    let a = 0.02;
    for (const [fc, bw, g] of [[700, 80, 1.0], [1200, 110, 0.55], [2600, 180, 0.35]]) a += g / (1 + ((f - fc) / bw) ** 2);
    return a;
  };
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = f0 * (1 + vibDepth * Math.sin(2 * Math.PI * 5.5 * i / SR));
    ph += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h * f0 < 5200; h++) v += gain(h * f0) * Math.sin(ph * h) / Math.sqrt(h);
    const env = Math.min(1, i / (SR * 0.05)) * Math.min(1, (n - i) / (SR * 0.10));
    out[i] = 0.28 * v * env + (rnd() - 0.5) * 3e-4;
  }
  return out;
}
function melody(f0s, dur = 1.4) {
  const parts = [];
  for (let i = 0; i < f0s.length; i++) {
    parts.push(tone(f0s[i], dur, { vibDepth: 0.025, seed: 5 + i }));
    parts.push(new Float64Array(Math.round(SR * 0.25)));
  }
  const out = new Float64Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Prožene signál živou cestou a vrátí rámce i s časem, výškou a SPR. */
async function frames(sig) {
  const dsp = await createDsp({ frameSize: FRAME_SIZE, sampleRate: SR, fach: 'tenor', wasmUrl: WASM });
  const state = createLiveState(SR, FRAME_SIZE);
  const core = new SprCore(SR, 4096);
  let pending = new Float64Array(0);
  const out = [];
  let t = 0;
  for (let b = 0; b + HOP <= sig.length; b += HOP) {
    const merged = new Float64Array(pending.length + HOP);
    merged.set(pending, 0); merged.set(sig.subarray(b, b + HOP), pending.length);
    let off = 0;
    while (merged.length - off >= FRAME_SIZE) {
      const end = off + FRAME_SIZE;
      const f0 = dsp.process(merged.subarray(off, end));
      const rms = dsp.rms(merged.subarray(off, end));
      const spr = core.of(merged.subarray(Math.max(0, end - 4096), end));
      out.push({ t: (b + off) / SR, f0, dbfs: 20 * Math.log10(rms || 1e-12), spr });
      off += HOP;
    }
    pending = merged.slice(off);
    t += HOP;
  }
  return out;
}

/**
 * Ustálené rámce: výška se drží aspoň `need` rámců v řadě a nepřeskočila
 * o víc než `tol` centů. Tím se vynechají náběhy a přechody mezi tóny.
 */
function steadyOnly(recs, need = 3, tol = 60) {
  const keep = [];
  let run = 0, last = 0;
  for (const r of recs) {
    if (!(r.f0 > 0)) { run = 0; last = 0; continue; }
    if (last > 0 && Math.abs(1200 * Math.log2(r.f0 / last)) <= tol) run++;
    else run = 1;
    last = r.f0;
    if (run >= need) keep.push(r);
  }
  return keep;
}

/** Jen rámce nad relativní úrovní hlasu (jako filtr v ringAnalysis). */
function loudOnly(recs, dropDb = 12) {
  const spls = recs.filter(r => r.f0 > 0 && Number.isFinite(r.dbfs)).map(r => r.dbfs).sort((a, b) => a - b);
  if (!spls.length) return [];
  const ref = spls[Math.min(spls.length - 1, Math.floor(0.75 * spls.length))];
  return recs.filter(r => r.f0 > 0 && r.dbfs >= ref - dropDb);
}

const cases = [
  ['melodie 5 tónů', melody([196, 247, 294, 330, 392])],
  ['melodie krátkých 0,5 s', melody([294, 330, 392, 440, 494], 0.5)],
  ['držený 440 Hz', tone(440, 6, { vibDepth: 0.03 })],
];

console.log('\nSOUHRN ŽIVÉHO ČÍSLA: co se zprůměruje (medián SPR)\n');
console.log('případ'.padEnd(24) + 'report'.padStart(9) + 'vše'.padStart(9)
  + 'ustálené'.padStart(11) + 'hlasité'.padStart(10) + 'ustál+hlas'.padStart(13) + 'rámců'.padStart(9));

for (const [label, sig] of cases) {
  const res = analyze(sig, SR, { fach: 'tenor' });
  const rep = res.summary.spr_novy_median;
  const recs = await frames(sig);
  const voiced = recs.filter(r => r.f0 > 0 && Number.isFinite(r.spr) && r.dbfs > -40);
  const st = steadyOnly(voiced);
  const lo = loudOnly(voiced);
  const stLo = steadyOnly(loudOnly(voiced));
  console.log(`${label.padEnd(24)}${Number.isFinite(rep) ? rep.toFixed(2).padStart(9) : '—'.padStart(9)}`
    + `${median(voiced.map(r => r.spr)).toFixed(2).padStart(9)}`
    + `${median(st.map(r => r.spr)).toFixed(2).padStart(11)}`
    + `${median(lo.map(r => r.spr)).toFixed(2).padStart(10)}`
    + `${median(stLo.map(r => r.spr)).toFixed(2).padStart(13)}`
    + `${voiced.length}/${st.length}`.padStart(9));
}

console.log('\nHotovo.');
