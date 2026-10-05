#!/usr/bin/env node
/**
 * Vyřazené tóny a rozsahy oborů — dvě věci, které uživatele poslaly hledat
 * chybu, která v datech nebyla.
 *
 * OVĚŘENO MUTACÍ (vrácení původních mezí / odebrání `dropped` z výsledku
 * musí test shodit).
 *
 * 1) ROZSAHY: mez musí ležet POD nejnižším tónem oboru, protože filtr vyhazuje
 *    při `med < loF` ostře. Původní meze (131 / 175 / 262) ukusovaly C3 (130,81),
 *    F3 (174,61) a C4 (261,63) — naměřeno, viz `tools/exp-hranice-rozsahu.mjs`.
 *
 * 2) VYŘAZENÉ ÚSEKY: `analyze()` musí vracet SEZNAM s důvodem, ne jen počet.
 *    Bez něj se „19 tónů, 9 vyřazeno" nedá dohledat — a rozdíl mezi „mimo obor",
 *    „příliš dlouhé" a „bez f0" vede k úplně jiné opravě.
 */
import { analyze, REFS } from '../src/analysis.js';

const RATE = 48000;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

/* ── syntetika: krátké držené tóny s pauzami, harmonická řada ───────────── */

function tone(f0, secs, rate = RATE, amp = 0.22) {
  const n = Math.round(secs * rate);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= 14; h++) {
      if (h * f0 > rate / 2 - 200) break;
      v += (1 / h) * Math.sin(2 * Math.PI * h * f0 * i / rate);
    }
    const fade = Math.min(1, i / 400) * Math.min(1, (n - i) / 400);
    out[i] = amp * v * fade;
  }
  return out;
}
function silence(secs, rate = RATE) { return new Float64Array(Math.round(secs * rate)); }
function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Float64Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

const HZ = { C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.00,
  C4: 261.63, D4: 293.66, E4: 329.63 };

console.log('\n═══ 1. Spodní mez rozsahu nesmí ukousnout nejnižší tón oboru ═══');
for (const [fach, note, hz] of [['tenor', 'C3', HZ.C3], ['alt', 'F3', HZ.F3], ['sopran', 'C4', HZ.C4]]) {
  const lo = REFS.fach_ranges[fach][0];
  check(`${fach}: mez ${lo} Hz leží pod ${note} = ${hz} Hz`, lo < hz,
    lo >= hz ? 'mez je NAD tónem → tón se vyhodí' : '');
}

/* Rezerva na rozladěný tón: C3 o 40 centů nízko = 127,8 Hz. Mez pod tím. */
const detunedC3 = HZ.C3 * Math.pow(2, -40 / 1200);
check(`tenor: mez ${REFS.fach_ranges.tenor[0]} Hz pod rozladěným C3 (−40 c = ${detunedC3.toFixed(1)} Hz)`,
  REFS.fach_ranges.tenor[0] < detunedC3, '');

console.log('\n═══ 2. C3 (130,81 Hz) se v tenoru opravdu ZMĚŘÍ ═══');
{
  const sig = concat(silence(0.5), tone(HZ.C3, 0.9), silence(0.4),
    tone(HZ.D3, 0.9), silence(0.4), tone(HZ.E3, 0.9), silence(0.3));
  const r = analyze(sig, RATE, { fach: 'tenor', fileRate: NaN });
  const f0s = r.notes.map(n => n.f0);
  const near = (hz) => f0s.find(g => Math.abs(1200 * Math.log2(g / hz)) < 60);
  check('C3 nalezeno (130,81 Hz)', !!near(HZ.C3), near(HZ.C3) ? `${near(HZ.C3).toFixed(1)} Hz` : 'chybí');
  check('D3 i E3 zůstaly', !!near(HZ.D3) && !!near(HZ.E3));
}

console.log('\n═══ 3. analyze() vrací seznam vyřazených úseků s důvodem ═══');
{
  /* „Mimo obor" se testuje na TENOROVÉM rozsahu s tónem 110 Hz (A2), který
   * leží pod mezí 123 Hz. Naměřeno (`tools/exp-hranice-rozsahu.mjs`): YIN
   * takový tón najde a filtr ho vyhodí jako „mimo tenor" — kdežto pod 70 Hz
   * (fMin YIN) by vypadl jako „bez f0" a test by netestoval filtr. */
  const sig = concat(
    silence(0.4),
    tone(220, 0.9), silence(0.4),                 // platný tón
    tone(110, 1.2), silence(0.4),                 // mimo obor tenor (A2 = 110 Hz)
    tone(180, 13.0), silence(0.4),                // příliš dlouhé (maxDur 12 s)
    tone(200, 0.9), silence(0.3),                 // platný tón
  );
  const r = analyze(sig, RATE, { fach: 'tenor', fileRate: NaN });
  check('výsledek má pole `dropped`', Array.isArray(r.dropped));
  const dr = r.dropped || [];
  check('počet v `n_dropped` odpovídá délce seznamu', r.n_dropped === dr.length,
    `n_dropped=${r.n_dropped} · seznam=${dr.length}`);
  check('každý vyřazený úsek má čas i důvod',
    dr.length > 0 && dr.every(d => Number.isFinite(d.t0) && Number.isFinite(d.t1) && typeof d.why === 'string' && d.why.length));
  check('je tam důvod „mimo obor"', dr.some(d => /mimo/.test(d.why)), dr.map(d => d.why).join(' | '));
  check('je tam důvod „příliš dlouhé"', dr.some(d => /dlouh/.test(d.why)));
  check('časy vyřazených leží uvnitř nahrávky',
    dr.every(d => d.t0 >= 0 && d.t1 <= r.duration_s + 0.01));
  check('důvody nejsou prázdné a nejdou přes sebe', dr.every(d => d.t1 > d.t0));
  check('důvod „mimo obor" nese jméno tónu a obor',
    dr.some(d => /mimo\s+tenor/.test(d.why) && /^[A-G]#?\d/.test(d.why)),
    dr.filter(d => /mimo/.test(d.why)).map(d => d.why).join(' | '));
}

console.log('\n═══ 4. Vyřazení nesmí ovlivnit tóny samotné ═══');
{
  /* Stejný signál dvakrát: seznam vyřazených nesmí být vázaný na tónech. */
  const sig = concat(silence(0.4), tone(220, 0.9), silence(0.5), tone(55, 1.0), silence(0.3));
  const a = analyze(sig, RATE, { fach: 'tenor', fileRate: NaN });
  const b = analyze(sig, RATE, { fach: 'tenor', fileRate: NaN });
  check('dvakrát stejný vstup → stejné tóny', JSON.stringify(a.notes.map(n => n.f0)) === JSON.stringify(b.notes.map(n => n.f0)));
  check('dvakrát stejný vstup → stejné vyřazené', JSON.stringify(a.dropped) === JSON.stringify(b.dropped));
  check('tóny nesou stejná data (spr)', a.summary.spr_median === b.summary.spr_median);
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass}/${pass + fail} kontrol prošlo`);
process.exit(fail === 0 ? 0 : 1);
