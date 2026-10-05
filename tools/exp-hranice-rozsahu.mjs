#!/usr/bin/env node
/* Hranice rozsahů vs. skutečné nejnižší tóny oborů.
 *
 * `REFS.fach_ranges` vypadají jako ZAOKROUHLENÉ NAHORU od nejnižšího tónu oboru:
 *   tenor  C3 = 130,81  → 131
 *   alt    F3 = 174,61  → 175
 *   soprán C4 = 261,63  → 262
 *   bas    E2 =  82,41  →  82  (tady dolů)
 * Filtr v `analyze()` vyhazuje tón, když `med < loF` — tedy OSTŘE. U zaokrouhlení
 * nahoru vypadne přesně nejnižší tón oboru.
 *
 * Test to měří syntetikou (rozhoduje jen výška, harmonická řada stačí).
 */
import { analyze, REFS } from '../src/analysis.js';

const RATE = 48000;
const NOTE_HZ = { C2: 65.41, E2: 82.41, G2: 98.00, A2: 110.00, B2: 123.47,
  C3: 130.81, ['C#3']: 138.59, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.00,
  A3: 220.00, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00 };

function tone(f0, secs, rate = RATE) {
  const n = Math.round(secs * rate);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= 14; h++) {
      if (h * f0 > rate / 2 - 200) break;
      v += (1 / h) * Math.sin(2 * Math.PI * h * f0 * i / rate);
    }
    out[i] = 0.22 * v;
  }
  return out;
}

function build(notes, rate = RATE) {
  const parts = [new Float64Array(rate)];
  for (const f0 of notes) {
    parts.push(tone(f0, 0.8, rate));
    parts.push(new Float64Array(Math.round(0.4 * rate)));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const sig = new Float64Array(total);
  let o = 0;
  for (const p of parts) { sig.set(p, o); o += p.length; }
  return sig;
}

/** Vrátí mapu: výška → změřená? */
function which(fach, notes) {
  const sig = build(notes);
  const r = analyze(sig, RATE, { fach, fileRate: NaN });
  const got = r.notes.map(n => n.f0);
  const out = new Map();
  for (const f0 of notes) {
    out.set(f0, got.find(g => Math.abs(1200 * Math.log2(g / f0)) < 60) ?? null);
  }
  return { out, n: r.n_notes, dropped: r.n_dropped };
}

const cases = {
  sopran: [NOTE_HZ.C4, NOTE_HZ.D4, NOTE_HZ.E4, NOTE_HZ.F4, NOTE_HZ.G4, NOTE_HZ.A4],
  alt: [NOTE_HZ.F3, NOTE_HZ.G3, NOTE_HZ.A3, NOTE_HZ.C4, NOTE_HZ.D4],
  tenor: [NOTE_HZ.C3, NOTE_HZ['C#3'], NOTE_HZ.D3, NOTE_HZ.E3, NOTE_HZ.F3, NOTE_HZ.G3],
  baryton: [NOTE_HZ.G2, NOTE_HZ.A2, NOTE_HZ.B2, NOTE_HZ.C3, NOTE_HZ.D3, NOTE_HZ.F3],
  bas: [NOTE_HZ.E2, NOTE_HZ.G2, NOTE_HZ.A2, NOTE_HZ.C3, NOTE_HZ.E3],
};

const names = Object.fromEntries(Object.entries(NOTE_HZ).map(([k, v]) => [v, k]));
for (const [fach, notes] of Object.entries(cases)) {
  const lo = REFS.fach_ranges[fach][0];
  const { out, dropped } = which(fach, notes);
  console.log(`\n${fach}  (rozsah od ${lo} Hz)`);
  for (const f0 of notes) {
    const m = out.get(f0);
    const isLowest = f0 === notes[0];
    console.log(`   ${String(names[f0] || f0).padEnd(5)} ${f0.toFixed(2).padStart(7)} Hz  ${m ? 'změřen  (' + m.toFixed(1) + ')' : 'VYŘAZEN'}${isLowest && !m ? '   ← NEJNIŽŠÍ TÓN OBORU' : ''}`);
  }
}
