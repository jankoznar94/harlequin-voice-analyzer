#!/usr/bin/env node
/* Ověřuje, které tóny se vyhodí FILTREM ROZSAHU — a konkrétně, jestli
 * vypadne C3 (130,81 Hz), což je pro tenor úplně normální nízký tón.
 *
 * Rozsah pro tenor je v `REFS.fach_ranges` [131.0, 660.0] Hz, ale C3 = 130,81 Hz.
 * Pokud filtr porovnává `med < loF`, je C3 pod mezí o 0,19 Hz a vypadne.
 * Tóny se syntetizují jako harmonická řada (jako v ostatních experimentech),
 * ale rozhoduje jen VÝŠKA, takže stačí krátké držené tóny.
 */
import { analyze, REFS } from '../src/analysis.js';

const RATE = 48000;
const NOTES = { A2: 110.00, ['A#2']: 116.54, B2: 123.47, C3: 130.81, ['C#3']: 138.59,
  D3: 146.83, ['D#3']: 155.56, E3: 164.81, F3: 174.61, G3: 196.00, A3: 220.00 };

function tone(f0, secs, rate = RATE) {
  const n = Math.round(secs * rate);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= 12; h++) {
      if (h * f0 > rate / 2 - 100) break;
      v += (1 / h) * Math.sin(2 * Math.PI * h * f0 * i / rate);
    }
    out[i] = 0.25 * v;
  }
  return out;
}

const parts = [new Float64Array(RATE)];   // úvodní ticho
const order = Object.keys(NOTES);
for (const k of order) {
  parts.push(tone(NOTES[k], 0.9));
  parts.push(new Float64Array(Math.round(0.35 * RATE)));   // pauza, ať se tóny neslijí
}
const total = parts.reduce((s, p) => s + p.length, 0);
const sig = new Float64Array(total);
let o = 0;
for (const p of parts) { sig.set(p, o); o += p.length; }

const r = analyze(sig, RATE, { fach: 'tenor', fileRate: NaN });
console.log(`rozsah tenor v kódu: ${REFS.fach_ranges.tenor.join('–')} Hz`);
console.log(`zadáno ${order.length} tónů (A2–A3) · analyze() vrátil ${r.n_notes} · vyřazeno ${r.n_dropped}\n`);
console.log('   nota     f0     změřený?  (změřené note/f0 z analýzy)');
const got = r.notes.map(n => n.f0);
for (const k of order) {
  const f0 = NOTES[k];
  const near = got.find(g => Math.abs(1200 * Math.log2(g / f0)) < 60);
  const below = f0 < REFS.fach_ranges.tenor[0];
  console.log(`  ${k.padEnd(5)} ${f0.toFixed(2).padStart(7)}   ${near ? 'ANO  (' + near.toFixed(1) + ' Hz)' : 'NE — VYŘAZEN'}${below ? '   ← pod mezí rozsahu' : ''}`);
}

console.log('\nPOZOR: `analyze()` vrací jen POČET vyřazených (`n_dropped`), ale ne seznam');
console.log('s důvodem — v exportovaném JSONu se tedy nedá zjistit, PROČ tón zmizel.');
