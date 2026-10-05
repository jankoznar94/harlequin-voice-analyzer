#!/usr/bin/env node
/* Proč se část tónů „nezměří"? Vypíše pro každý nalezený tón výšku, délku,
 * hlasitost a ZDA a PROČ vypadl — a totéž shrne po půloktávách, aby bylo vidět,
 * jestli se to děje v nízké poloze víc.
 *
 * Použití: node tools/diag-vyrazene.mjs soubor.wav [fach]
 */
import { execFileSync } from 'node:child_process';
import { analyze } from '../src/analysis.js';

const SRC = process.argv[2] || 'rec-test/zpev.wav';
const FACH = process.argv[3] || 'tenor';
const RATE = 48000;

const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', SRC, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
const n = Math.floor(pcm.length / 4);
const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
const s = new Float64Array(n);
for (let i = 0; i < n; i++) s[i] = dv.getFloat32(i * 4, true);

const r = analyze(s, RATE, { fach: FACH, fileRate: NaN });
const sum = r.summary || {};
console.log(`soubor: ${SRC} · rozsah ${FACH}`);
console.log(`nalezeno tónů: ${r.n_notes} · mimo rozsah/dlouhé vyřazeno: ${r.n_dropped}`);
console.log(`do ringu použito: ${sum.n_notes} · vyřazeno krátkých: ${sum.n_excluded_short} · tichých: ${sum.n_excluded_quiet}`);
console.log(`filtr tichých aplikován: ${sum.filter_applied} · mez hlasitosti: ${sum.min_dur_used} s / ${sum.spl_drop_used} dB pod ${sum.med_spl_dbfs?.toFixed(1)} dBFS`);

// rekonstrukce: které tóny jsou v `usable` (stejná pravidla jako ringAnalysis)
const minDur = sum.min_dur_used ?? 0.30, splDrop = sum.spl_drop_used ?? 20;
const spls = r.notes.map(x => x.spl_dbfs).filter(v => v === v).sort((a, b) => a - b);
const medSpl = spls.length ? spls[Math.min(spls.length - 1, Math.floor(0.75 * spls.length))] : -Infinity;
const splMin = medSpl - splDrop;
console.log(`p75 hlasitosti: ${medSpl.toFixed(1)} dBFS → mez pro vyřazení tichých: ${splMin.toFixed(1)} dBFS\n`);

console.log('   čas    nota    f0 Hz   délka  SPL dB   stav');
const rows = [];
for (const x of r.notes) {
  const short = x.dur < minDur, quiet = x.spl_dbfs < splMin;
  const stav = short ? 'KRÁTKÝ' : quiet ? 'TICHÝ' : 'ok';
  rows.push({ f0: x.f0, dur: x.dur, spl: x.spl_dbfs, stav });
  console.log(`${(Math.floor(x.t_start / 60) + ':' + String(Math.round(x.t_start % 60)).padStart(2, '0')).padStart(7)}  ${String(x.note).padEnd(6)} ${x.f0.toFixed(0).padStart(6)}  ${x.dur.toFixed(2).padStart(5)}  ${x.spl_dbfs.toFixed(1).padStart(6)}   ${stav}`);
}
if (r.dropped?.length) {
  console.log('\nvyřazené úseky (mimo rozsah / příliš dlouhé):');
  for (const d of r.dropped.slice(0, 40)) {
    console.log(`  ${Math.round(d.t0)}–${Math.round(d.t1)} s: ${d.why}`);
  }
}

// souhrn po půloktávách
const bins = new Map();
for (const x of rows) {
  const k = Math.round(x.f0 / 30) * 30;
  if (!bins.has(k)) bins.set(k, { ok: 0, bad: 0 });
  const b = bins.get(k);
  x.stav === 'ok' ? b.ok++ : b.bad++;
}
console.log('\npo pásmech (30 Hz): pásmo · změřené · vyřazené');
for (const k of [...bins.keys()].sort((a, b) => a - b)) {
  const b = bins.get(k);
  console.log(`  ${String(k).padStart(4)}–${k + 30} Hz: ${String(b.ok).padStart(3)} · ${String(b.bad).padStart(3)}`);
}
