#!/usr/bin/env node
/**
 * EXPERIMENT: parametry časové řady SPR uvnitř tónu.
 *
 * Cíl: kreslit SPR po celou dobu tónu (Jan: „ať je tam co nejvíc údajů“),
 * ale tak, aby číslo odpovídalo tomu, co dnes vychází jako `spr_novy`
 * (p90 z oken 4096 na TĚLE tónu = 60 % uprostřed). Když se měří přes celý
 * tón, přibude attack (náběh) a dokmit — a to jsou přechodové jevy, kde SPR
 * nepopisuje ustálený hlas.
 *
 * Tohle měření má říct TŘI věci:
 *   1. jak moc se liší p90 na celém tónu od p90 na těle 60 % (posun čísla)
 *   2. kolik prvních/posledních oken je kontaminovaných náběhem (ms)
 *   3. kolik dB se v průběhu tónu opravdu ujede (má smysl kreslit?)
 *
 * Použití: node tools/exp-spr-serie.mjs soubor.wav [minDur]
 */
import { readFileSync } from 'node:fs';
import { analyze, percentile, SPR_NFFT, SprCore } from '../src/analysis.js';

function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('není RIFF/WAV');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = b.subarray(body, body + sz);
    off = body + sz + (sz & 1);
  }
  const { channels, bits, format } = fmt;
  const n = Math.floor(data.length / (channels * bits / 8));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * channels * (bits / 8);
    out[i] = bits === 16 ? data.readInt16LE(o) / 32768
      : bits === 32 && format === 3 ? data.readFloatLE(o)
      : (data[o] - 128) / 128;
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}

/** Časová řada SPR: okno SPR_NFFT, krok SPR_NFFT/4 (21 ms @48k). */
function series(x, sr, hopDiv = 4) {
  const nfft = SPR_NFFT;
  const step = Math.max(128, Math.round(nfft / hopDiv));
  const core = new SprCore(sr, nfft);
  const vals = [], ts = [];
  for (let s = 0; s + nfft <= x.length; s += step) {
    const v = core.of(x.subarray(s, s + nfft));
    if (v === v) { vals.push(v); ts.push(s / sr); }
  }
  return { vals, ts, step };
}

/** EMA jako v živém indikátoru (α = 0,35). */
function ema(vals, a = 0.35) {
  let e = NaN;
  return vals.map(v => (e = e !== e ? v : a * v + (1 - a) * e));
}

const file = process.argv[2];
const minDur = Number(process.argv[3] || 1.0);
const { samples, sampleRate: SR } = readWav(file);
const res = analyze(samples, SR, { fach: 'tenor' });
console.log(`\n### ${file} — ${(samples.length / SR).toFixed(1)} s · tónů ${res.summary.n_notes}`
  + ` · SPR nový medián ${res.summary.spr_novy_median?.toFixed(2)} dB`);

const long = res.notes.filter(n => n.dur >= minDur);
console.log(`dlouhých tónů (>= ${minDur} s): ${long.length}\n`);

const rows = [];
for (const n of long) {
  const i0 = Math.round(n.t_start * SR), i1 = Math.round(n.t_end * SR);
  const whole = samples.subarray(i0, i1);
  const bodyA = Math.round(0.20 * whole.length), bodyB = Math.round(0.80 * whole.length);
  const body = whole.subarray(bodyA, bodyB);

  const S_whole = series(whole, SR);
  const S_body = series(body, SR);
  const p90 = (v) => percentile(v, 0.90);
  const med = (v) => percentile(v, 0.50);

  // Kde se řada na celém tónu ustálí? První okno, od kterého je EMA do 1 dB
  // od p90 těla — tím se pozná délka kontaminace náběhem.
  const E = ema(S_whole.vals);
  const target = p90(S_body.vals);
  let stable = -1;
  for (let i = 0; i < E.length; i++) {
    if (E.slice(i, Math.min(i + 5, E.length)).every(v => Math.abs(v - target) < 1.5)) { stable = i; break; }
  }

  rows.push({
    note: n.note, t0: n.t_start, dur: n.dur, f0: n.f0,
    nWhole: S_whole.vals.length, nBody: S_body.vals.length,
    p90Whole: p90(S_whole.vals), p90Body: p90(S_body.vals), stored: n.spr_novy,
    medWhole: med(S_whole.vals), medBody: med(S_body.vals),
    spreadWhole: Math.max(...S_whole.vals) - Math.min(...S_whole.vals),
    spreadEma: Math.max(...E) - Math.min(...E),
    iqrEma: percentile([...E].sort((a, b) => a - b), 0.75) - percentile([...E].sort((a, b) => a - b), 0.25),
    stableMs: stable < 0 ? NaN : stable * S_whole.step / SR * 1000,
    stepMs: S_whole.step / SR * 1000,
  });
}

console.log('tón    dur   rámců   p90 celý  p90 tělo  uložené   med celý  med tělo  rozkmit  EMA rozkmit  IQR(EMA)  ustálení');
for (const r of rows) {
  const f = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d) : '—';
  console.log(`${r.note.padEnd(5)} ${f(r.dur)}s ${String(r.nWhole).padStart(5)} ${f(r.p90Whole).padStart(9)} ${f(r.p90Body).padStart(9)} ${f(r.stored).padStart(9)}`
    + ` ${f(r.medWhole).padStart(9)} ${f(r.medBody).padStart(9)} ${f(r.spreadWhole).padStart(8)} ${f(r.spreadEma).padStart(11)} ${f(r.iqrEma).padStart(9)}`
    + ` ${Number.isFinite(r.stableMs) ? (r.stableMs.toFixed(0) + ' ms') : '—'}`);
}

if (rows.length) {
  const med = (v) => { const s = [...v].filter(x => Number.isFinite(x)).sort((a, b) => a - b); return s[s.length >> 1]; };
  const dP90 = rows.map(r => r.p90Whole - r.p90Body);
  console.log('\n### souhrn');
  console.log(`p90(celý tón) − p90(tělo 60 %) : medián ${med(dP90).toFixed(2)} dB, rozsah ${Math.min(...dP90).toFixed(2)}…${Math.max(...dP90).toFixed(2)} dB`);
  console.log(`rozkmit uvnitř tónu           : surově medián ${med(rows.map(r => r.spreadWhole)).toFixed(1)} dB`
    + ` · po EMA medián ${med(rows.map(r => r.spreadEma)).toFixed(1)} dB · IQR(EMA) medián ${med(rows.map(r => r.iqrEma)).toFixed(2)} dB`);
  console.log(`krok řady ${rows[0].stepMs.toFixed(1)} ms · hodnot na tón: medián ${med(rows.map(r => r.nWhole))}`);
  console.log(`ustálení po náběhu: medián ${med(rows.map(r => r.stableMs)).toFixed(0)} ms`);
}
