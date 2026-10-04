#!/usr/bin/env node
/**
 * EXPERIMENT 7: je rozptyl SPR mezi tóny vlastnost HLASU, nebo METODY?
 *
 * Na reálném zpěvu vychází rozchod dvou polovin téhož tónu ~3,8 dB — metoda
 * se sama se sebou neshodne. Otázka je, jestli je to chyba měření, nebo jestli
 * se tón v čase skutečně mění (vibrato, rozladění, rozpad tónu, změna vokálu).
 *
 * Testuje se proto: koreluje rozchod polovin s tím, jak NESTABILNÍ byl tón?
 * Když ano, rozptyl patří hlasu a není co opravovat — jen to přiznat v UI.
 */
import { readFileSync } from 'node:fs';
import { ltas, spr, analyze } from '../src/analysis.js';

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
const corr = (A, B) => {
  const xs = [], ys = [];
  for (let i = 0; i < A.length; i++) if (A[i] === A[i] && B[i] === B[i]) { xs.push(A[i]); ys.push(B[i]); }
  if (xs.length < 4) return NaN;
  const ma = mean(xs), mb = mean(ys);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - ma) * (ys[i] - mb); da += (xs[i] - ma) ** 2; db += (ys[i] - mb) ** 2; }
  return num / Math.sqrt(da * db || 1);
};
function loadWav(p) {
  const b = readFileSync(p);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = b.subarray(body, body + sz);
    off = body + sz + (sz & 1);
  }
  const N = Math.floor(data.length / (fmt.ch * fmt.bits / 8)), x = new Float64Array(N);
  for (let i = 0; i < N; i++) { let a = 0; for (let c = 0; c < fmt.ch; c++) a += data.readInt16LE((i * fmt.ch + c) * (fmt.bits / 8)) / 32768; x[i] = a / fmt.ch; }
  return { samples: x, sampleRate: fmt.sr };
}

const FILES = [
  `${process.env.HOME}/.cache/vaud-test/zpev.wav`,
  `${process.env.HOME}/.cache/vaud-test/zpev_s_doprovodem.wav`,
  `${process.env.HOME}/.cache/vaud-test/caruso-riv.wav`,
];

for (const f of FILES) {
  let L;
  try { L = loadWav(f); } catch { continue; }
  const res = analyze(L.samples, L.sampleRate, { fach: 'tenor' });
  const sp = res.notes.filter(n => n.spr === n.spr).map(n => n.spl_dbfs).sort((a, b) => a - b);
  const splRef = sp.length ? sp[Math.min(sp.length - 1, Math.floor(0.75 * sp.length))] : NaN;
  const usable = res.notes.filter(n => n.spr === n.spr && n.dur >= 0.30 && n.spl_dbfs >= splRef - 20);
  if (!usable.length) { console.log(`${f.split('/').pop()}: žádné měřitelné tóny`); continue; }

  const rows = [];
  for (const n of usable) {
    const dur = n.t_end - n.t_start;
    const a = n.t_start + 0.20 * dur, b = n.t_end - 0.20 * dur;
    const i0 = Math.max(0, Math.floor(a * L.sampleRate)), i1 = Math.min(L.samples.length, Math.ceil(b * L.sampleRate));
    if (i1 - i0 < 4096) continue;
    const mid = (i0 + i1) >> 1;
    const v1 = spr(ltas(L.samples.subarray(i0, mid), L.sampleRate, 4096));
    const v2 = spr(ltas(L.samples.subarray(mid, i1), L.sampleRate, 4096));
    if (!(v1 === v1) || !(v2 === v2)) continue;
    rows.push({ ro: Math.abs(v1 - v2), dur, sd: n.f0_sd_cents, span: n.span_cents, vib: n.vib_extent_cents, spl: n.spl_dbfs });
  }
  console.log(`\n${f.split('/').pop()}  (${rows.length} tónů)`);
  console.log(`  rozchod polovin   : medián ${median(rows.map(r => r.ro)).toFixed(2)} dB`);
  console.log(`  korelace rozchodu s NESTABILITOU tónu:`);
  console.log(`    f0_sd_cents        r = ${corr(rows.map(r => r.ro), rows.map(r => r.sd)).toFixed(3)}`);
  console.log(`    span_cents (rozkmit) r = ${corr(rows.map(r => r.ro), rows.map(r => r.span)).toFixed(3)}`);
  console.log(`    vibrato rozkmit    r = ${corr(rows.map(r => r.ro), rows.map(r => r.vib)).toFixed(3)}`);
  console.log(`    délka tónu         r = ${corr(rows.map(r => r.ro), rows.map(r => r.dur)).toFixed(3)}`);
  // rozděl na stabilní a nestabilní
  const srt = [...rows].sort((a, b) => a.sd - b.sd);
  const q = Math.max(1, Math.floor(srt.length / 3));
  const stabil = srt.slice(0, q), nestab = srt.slice(-q);
  console.log(`  NEJSTABILNĚJŠÍ třetina (f0_sd ${median(stabil.map(r => r.sd)).toFixed(0)} centů): rozchod ${median(stabil.map(r => r.ro)).toFixed(2)} dB`);
  console.log(`  NEJNESTABILNĚJŠÍ třetina (f0_sd ${median(nestab.map(r => r.sd)).toFixed(0)} centů): rozchod ${median(nestab.map(r => r.ro)).toFixed(2)} dB`);
}
