/**
 * Regrese: DRŽENÝ tón se nesmí slepit do jednoho úseku s rozkmitem přes oktávu.
 *
 * ⚠️ REÁLNÁ VADA (naměřeno v JSONu z aplikace): uživatel nahrál držený tón
 * na „A" (D3) a analýza vrátila **jeden** tón o délce 5,36 s s rozkmitem
 * **1328 centů**, `is_glide: true`, `f0_sd_cents` 103. Uživatel to viděl jako
 * jednu hodnotu v grafu místo pěti vteřin tónu a čísla z toho byla nesmyslná:
 *
 *   SPR −23,73 dB   (na jeho jiné nahrávce −13,8 dB)
 *   FHE 3023 Hz     (tenorská reference 2705 ± 221)
 *   `ring_above_ref: false` → podle skóre „špatný ring"
 *
 * Mechanismus: když je slabý základní tón (málo opory, vytažený hrtan),
 * YIN latuje mezi f0 a jeho násobky. Segmentace takové rámce dosud brala
 * jako jednu notu — `spanCents` se jen PŘIZNAL (`is_glide`), ale
 * `measureNote()` z něj počítal medián přes CELÝ úsek. Číslo tedy
 * nepopisovalo ani jeden zpívaný tón.
 *
 * OVĚŘENO MUTACÍ: vypnutí bloku `split` v `countNotePlateaus()` shodí
 * sekci 1 (rozkmit zůstane přes 700 centů).
 */
import { analyze } from '../src/analysis.js';

const SR = 48000;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/**
 * Hlas: harmonická řada s formantovou obálkou a zadanou konturou f0.
 *
 * ⚠️ FÁZE SE INTEGRUJE, ne počítá jako `sin(2π·f(t)·t)` — s měnícím se f
 * dělá druhá varianta fázové skoky a YIN v tom výšku nenajde (naměřeno:
 * 45–70 rámců z 396). Test by pak hlásil vadu kódu, která vznikla v testu.
 */
function voice(dur, kontura, f0base = 146.83, nharm = 60) {
  const n = Math.round(dur * SR), out = new Float64Array(n);
  const faze = new Float64Array(nharm + 1);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f0 = f0base * kontura(t);
    let v = 0;
    for (let h = 1; h <= nharm; h++) {
      const f = f0 * h;
      if (f >= SR / 2) break;
      faze[h] += 2 * Math.PI * f / SR;
      let a = 1 / h ** 1.1;
      a *= 1 + 5 / (1 + ((f - 600) / 900) ** 2);
      a *= 1 + 3 / (1 + ((f - 1300) / 1100) ** 2);
      v += a * Math.sin(faze[h]);
    }
    out[i] = 0.18 * v;
  }
  return out;
}

console.log('\n═══ Slepence: rozkmit přes oktávu není jeden tón ═══');
{
  /* 1) Kontura, která na chvíli uskočí o oktávu výš (přesně to YIN na slabém
   *    „A" dělá). Musí vzniknout ODDĚLENÉ tóny, ne jeden slepenec. */
  const x = voice(5.4, (t) => (t > 1.3 && t < 1.9) ? 2.0 : 1.0);
  const r = analyze(x, SR, { fach: 'tenor' });
  check('oktávový skok se NESLEPÍ do jednoho tónu', r.notes.length >= 2,
    `tónů ${r.notes.length}`);
  check('žádný tón nemá rozkmit přes 700 centů',
    r.notes.every(n => n.span_cents <= 700),
    `spans ${r.notes.map(n => Math.round(n.span_cents)).join(', ')}`);
  check('hlášený f0 odpovídá zpívanému D3, ne slepenci',
    r.notes.some(n => Math.abs(n.f0 - 146.83) < 4),
    `f0: ${r.notes.map(n => n.f0.toFixed(1)).join(', ')}`);

  /* 2) POJISTKA: stabilní držený tón musí zůstat JEDEN. Pojistka proti
   *    slepencům nesmí rozbít normální případ — to je hlavní riziko změny. */
  const stabil = voice(5.4, () => 1.0);
  const rs = analyze(stabil, SR, { fach: 'tenor' });
  check('stabilní držený tón zůstává JEDEN', rs.notes.length === 1,
    `tónů ${rs.notes.length}, dur ${rs.notes[0]?.dur.toFixed(2)} s`);

  /* 3) Vibrato ±70 centů je jeden tón, ne dva — pojistka nesmí rozdělovat
   *    běžné vibrato. */
  const vib = voice(4.0, (t) => Math.pow(2, (70 / 1200) * Math.sin(2 * Math.PI * 5 * t)));
  const rv = analyze(vib, SR, { fach: 'tenor' });
  check('vibrato ±70 centů zůstává jeden tón', rv.notes.length === 1,
    `tónů ${rv.notes.length}, span ${rv.notes.map(n => Math.round(n.span_cents)).join(', ')}`);

  /* 4) A hlavně: DRŽENÝ tón musí dát použitelné číslo — když se nerozdělí
   *    správně, SPR vyjde jako z mediánu přes víc tónů (uživatel: −23,7 dB
   *    proti −13,8 dB na jiné nahrávce téhož hlasu). */
  const r1 = analyze(voice(4.0, () => 1.0), SR, { fach: 'tenor' });
  check('držený tón dá SPR jako číslo', Number.isFinite(r1.summary.spr_median),
    `SPR ${r1.summary.spr_median?.toFixed(1)} dB`);
  check('držený tón nemá rozkmit výšky v desítkách centů',
    r1.notes.every(n => n.f0_sd_cents < 20),
    `f0_sd ${r1.notes.map(n => n.f0_sd_cents.toFixed(1)).join(', ')} centů`);
}

console.log(`\n═══ VÝSLEDEK: ${pass} prošlo, ${fail} selhalo ═══`);
process.exit(fail ? 1 : 0);
