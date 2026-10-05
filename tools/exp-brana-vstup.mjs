#!/usr/bin/env node
/* Změří, co dělá BRÁNA PÁSMA s tímtéž obsahem při různých vstupních údajích
 * o vzorkovacím kmitočtu — a hlavně co udělá, když je kmitočet NEPOZNANÝ
 * (což je přesně případ nahrávky z aplikace: webm/opus hlavičku `sniffSampleRate`
 * nepozná → `knownRate=false` → přísná absolutní mez).
 *
 * Vstup: soubor (ideálně reálný zpěv), zkouší se 48k / 16k / 12k převzorkování.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { analyze } from '../src/analysis.js';
import { sniffSampleRate } from '../src/sample-rate.js';

const SRC = process.argv[2] || 'rec-test/zpev.wav';
const buf = readFileSync(SRC);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
console.log(`zdroj: ${SRC}`);
console.log(`sniffSampleRate na TOMTO souboru: ${sniffSampleRate(ab)}`);

function loadMono(path, rate) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1',
    '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const n = Math.floor(pcm.length / 4);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = dv.getFloat32(i * 4, true);
  return s;
}

console.log('\n  kmit. | fileRate  | limit | raw   | bandCut | valid | tóny | SPR');
console.log('  ------+-----------+-------+-------+---------+-------+------+------');
for (const rate of [48000, 22050, 16000, 12000]) {
  const s = loadMono(SRC, rate);
  for (const [label, fr] of [['známý ' + rate / 1000 + 'k', rate], ['NEPOZNÁN  ', NaN]]) {
    const r = analyze(s, rate, { fileRate: fr });
    const b = r.band;
    const cut = b.band_rel === undefined ? '   —   ' : b.band_rel.toFixed(1);
    console.log(`  ${String(rate / 1000).padStart(5)}k | ${label} | ${String(Math.round(b.limit)).padStart(5)} | ` +
      `${String(Math.round(b.limit_raw)).padStart(5)} | ${String(cut).padStart(7)} | ${String(b.valid).padEnd(5)} | ` +
      `${String(r.n_notes).padStart(4)} | ${b.valid ? (r.summary.spr_median?.toFixed(1) ?? '—') : 'NELZE'}`);
    if (!b.valid) console.log(`         → ${b.reason}`);
  }
}

console.log('\n── ořezané zdroje (musí zůstat ODMÍTNUTÉ i s mírnější branou) ──');
for (const f of ['bw3400-48k.wav', 'bw3700-48k.wav', 'bw5000-48k.wav']) {
  const p = `${process.env.HOME}/.cache/vaud-test/${f}`;
  try {
    const s = loadMono(p, 48000);
    for (const [label, fr] of [['známý', 48000], ['NEPOZNÁN', NaN]]) {
      const r = analyze(s, 48000, { fileRate: fr });
      console.log(`  ${f.padEnd(16)} (${label.padEnd(8)}) limit ${String(Math.round(r.band.limit)).padStart(5)} Hz · ` +
        `bandCut ${(r.band.band_rel ?? NaN).toFixed(1)} dB · valid=${r.band.valid} · ${r.band.valid ? '' : r.band.reason}`);
    }
  } catch (e) { console.log(`  ${f}: ${e.message}`); }
}
