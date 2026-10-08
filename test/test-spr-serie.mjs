#!/usr/bin/env node
/**
 * Test časové řady SPR uvnitř tónu (`sprSeries`) a její kresby v grafu ringu.
 *
 * PROČ: držený tón měl v grafu jedinou hodnotu, i když trvá pět vteřin a ring
 * se v jejich průběhu mění (naměřeno na reálném zpěvu: IQR uvnitř tónu 6,45 dB,
 * pokles až 13,7 dB). Uživatel neměl jak poznat, jestli ring drží od náběhu
 * do konce, nebo na konci padá.
 *
 * Test hlídá TŘI věci, které se dají pokazit tiše:
 *   1. řada se stejným měřením jako `spr_novy` (jinak by si graf a report
 *      odporovaly — dvě čísla z různých světů na jednom tónu),
 *   2. změnu ringu v čase OPRAVDU ukáže (tón s řízeným poklesem),
 *   3. na stabilním tónu si žádný pokles nevymyslí.
 *   4. kresba: dlouhý tón s řadou se kreslí jako křivka (ne sloupec).
 */
import { sprSeries, analyze, percentile, SPR_SERIE_MIN_DUR, SPR_NFFT, SprCore } from '../src/analysis.js';

globalThis.window = { devicePixelRatio: 1 };
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) };
const { drawSpr, sprGeom } = await import('../src/charts.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

const SR = 48000;

/**
 * Tón s harmonickou řadou pod rezonanční obálkou; jasnost (a tím SPR) se
 * mění podle `brightAt(t)`. Fáze se INTEGRUJE — `sin(2π·f·t)` s měnícím se
 * parametrem dělá fázové skoky (past, která se v tomto repu už jednou
 * projevila jako „YIN nenašel výšku“).
 */
function tone(n, f0, brightAt, vibPct = 0) {
  const out = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const b = brightAt(i / SR);
    /* Vibrato je tu SCHVÁLNĚ: bez něj je tón dokonale periodický, SPR
     * v rámcích má nulový rozptyl, medián == p90 — a test pak nepozná,
     * kdyby se počítala špatná statistika. Ověřeno mutací: s vibratem
     * (5 %, hloubka 3 %) se záměna p90 za medián v testu projeví. */
    const f = f0 * (1 + (vibPct / 100) * Math.sin(2 * Math.PI * 5 * i / SR));
    ph += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h * f0 < 5200; h++) {
      const fh = h * f0;
      const F = [[700, 1.0, 110], [1220, 0.5, 130], [2600, b * 0.35, 190]];
      let g = 0;
      for (const [fc, a, bw] of F) g += a / (1 + ((fh - fc) / bw) ** 2);
      v += Math.max(0.03, g) * Math.sin(h * ph) / Math.sqrt(h);
    }
    out[i] = 0.25 * v;
  }
  return out;
}

console.log('\n═══ 1. Řada vzniká a má správné rozměry ═══');
{
  const x = tone(Math.round(3 * SR), 220, () => 1);
  const ser = sprSeries(x, SR);
  // okno 0,2 s, krok 0,05 s → (3 − 0,2) / 0,05 + 1 = 57 bodů
  check('3 s tón → 57 bodů', ser.length === 57, `${ser.length} bodů`);
  check('časy rostou od 0', ser[0][0] === 0 && ser[1][0] > 0, `t0=${ser[0][0]}, t1=${ser[1][0]}`);
  check('časy nepřesáhnou délku tónu', ser[ser.length - 1][0] <= 3, `${ser[ser.length - 1][0].toFixed(2)} s`);
  check('všechny hodnoty jsou konečná čísla', ser.every(p => Number.isFinite(p[1])));

  const short = sprSeries(tone(Math.round(0.3 * SR), 220, () => 1), SR);
  check('krátký tón (0,3 s) → prázdná řada (okno 0,2 s se nevejde dvakrát)', short.length <= 3, `${short.length} bodů`);
  const tiny = sprSeries(tone(Math.round(0.1 * SR), 220, () => 1), SR);
  check('velmi krátký tón → prázdná řada', tiny.length === 0, `${tiny.length} bodů`);
}

console.log('\n═══ 2. Změnu ringu OPRAVDU ukáže (známá pravda) ═══');
{
  const T = 3;
  const x = tone(Math.round(6 * SR), 220, (t) => (t < T ? 1 : 0.10));
  const ser = sprSeries(x, SR);
  const h = Math.floor(ser.length / 2);
  const a = percentile(ser.slice(0, h).map(p => p[1]), 0.5);
  const b = percentile(ser.slice(h).map(p => p[1]), 0.5);
  check('ring v druhé polovině výrazně klesl', b - a < -10, `${a.toFixed(1)} → ${b.toFixed(1)} dB (rozdíl ${(b - a).toFixed(1)})`);
  check('pokles je zhruba tam, kde byl zadán', Math.abs(ser[h][0] - T) < 0.3, `hranice v řadě ${ser[h][0].toFixed(2)} s, zadáno ${T} s`);
}

console.log('\n═══ 3. Stabilnímu tónu pokles NEVYMYSÍ ═══');
{
  const x = tone(Math.round(4 * SR), 220, () => 1);
  const ser = sprSeries(x, SR);
  const h = Math.floor(ser.length / 2);
  const a = percentile(ser.slice(0, h).map(p => p[1]), 0.5);
  const b = percentile(ser.slice(h).map(p => p[1]), 0.5);
  check('rozdíl polovin je malý (do 1 dB)', Math.abs(b - a) < 1, `${a.toFixed(2)} → ${b.toFixed(2)} dB`);
  const v = ser.map(p => p[1]);
  check('rozkmit řady je malý (do 2 dB)', Math.max(...v) - Math.min(...v) < 2, `${(Math.max(...v) - Math.min(...v)).toFixed(2)} dB`);
}

console.log('\n═══ 4. Stejné měření jako číslo tónu (spr_novy) ═══');
{
  /* Kdyby řada měřila něco jiného než `spr_novy`, ukazoval by graf jinou
   * hodnotu, než jakou tvrdí report — a to je přesně stav, kterému se celý
   * tenhle repozitář vyhýbá (živý indikátor vs. report). */
  const x = tone(Math.round(3 * SR), 220, () => 1, 3);
  const res = analyze(x, SR, { fach: 'tenor' });
  check('analyze() dalo tón', res.notes.length === 1, `${res.notes.length} tónů`);
  const n = res.notes[0];
  check('tón s řadou (>= práh) řadu má', !!n.spr_series, `délka ${n.dur.toFixed(2)} s, práh ${SPR_SERIE_MIN_DUR}`);
  const med = percentile(n.spr_series.map(p => p[1]), 0.5);
  check('medián řady ≈ spr_novy (do 2 dB)', Math.abs(med - n.spr_novy) < 2,
    `medián řady ${med.toFixed(2)} vs spr_novy ${n.spr_novy.toFixed(2)}`);
}

console.log('\n═══ 4b. Správná statistika uvnitř okna (p90, ne medián) ═══');
{
  /* Přímé ověření proti RUČNÍMU výpočtu. Nutné proto, že na syntetice se
   * p90 a medián uvnitř okna liší jen o ~0,13 dB — kdyby se test jen díval
   * na medián řady, záměnu statistiky by NEPOZNAL (ověřeno mutací: takto to
   * poprvé prošlo, i když kód počítal medián). Přesné porovnání hodnoty to
   * odhalí bez ohledu na to, jak je rozdíl malý. */
  const x = tone(Math.round(2 * SR), 220, () => 1, 3);
  const ser = sprSeries(x, SR);
  const core = new SprCore(SR, SPR_NFFT);
  const win = Math.round(0.20 * SR), inner = Math.round(SPR_NFFT / 4);
  const tmp = [];
  for (let u = 0; u + SPR_NFFT <= win; u += inner) {
    const v = core.of(x.subarray(u, u + SPR_NFFT));
    if (v === v) tmp.push(v);
  }
  const manualP90 = percentile(tmp, 0.90);
  const manualMed = percentile(tmp, 0.50);
  check('první bod řady == ručně spočítaný p90 okna', Math.abs(ser[0][1] - manualP90) < 1e-9,
    `řada ${ser[0][1].toFixed(6)} vs ručně ${manualP90.toFixed(6)}`);
  check('kontrola, že v okně p90 ≠ medián (test má co měřit)', Math.abs(manualP90 - manualMed) > 1e-6,
    `p90 ${manualP90.toFixed(4)} vs medián ${manualMed.toFixed(4)}, rozdíl ${(manualP90 - manualMed).toFixed(4)} dB`);
}

console.log('\n═══ 5. Kresba: dlouhý tón s řadou = KŘIVKA, ne sloupec ═══');
{
  /* Mock canvasu, který si pamatuje, co se kreslilo. Sloupec = fillRect
   * zdola nahoru, křivka = stroke přes body. Kdyby kód křivky vypadl,
   * projde kresba sloupcem a test to musí poznat. */
  const strokes = [], fills = [];
  const ctx = {
    setTransform() {}, fillText() {}, save() {}, restore() {}, setLineDash() {},
    beginPath() {}, closePath() {}, clip() {}, rect() {},
    moveTo() {}, lineTo() { strokes.push(1); },
    stroke() { strokes.push('S'); },
    fill() { fills.push('F'); },
    fillRect() { fills.push('R'); },
  };
  const canvas = { clientWidth: 600, clientHeight: 230, style: {}, getContext: () => ctx };
  const mk = (series) => ([{
    idx: 1, t_start: 1, t_end: 6, dur: 5, note: 'C#3', f0: 140,
    spr: -24, spr_novy: -18, ring_ok: true, ring_dropout: false,
    ...(series ? { spr_series: series } : {}),
  }]);
  const summary = { ring_threshold: -27 };

  strokes.length = 0; fills.length = 0;
  const ser = Array.from({ length: 20 }, (_, i) => [i * 0.25, -14 - i * 0.8]);
  const g1 = drawSpr(canvas, mk(ser), summary);
  check('tón s řadou → křivka se kreslí (stroke)', strokes.filter(x => x === 'S').length >= 3,
    `${strokes.filter(x => x === 'S').length} tahů`);
  check('tón s řadou → plocha stuhy se vyplní', fills.includes('F'), fills.join(''));
  check('geometrie se vrátila (klik do grafu funguje)', !!g1 && typeof g1.timeAtX === 'function');

  strokes.length = 0; fills.length = 0;
  drawSpr(canvas, mk(null), summary);
  check('tón bez řady → kreslí se sloupec (fillRect)', fills.includes('R') && !fills.includes('F'), fills.join(''));

  /* Osa musí pojmout krajní bod řady, jinak se křivka ořízne o okraj. */
  const wide = Array.from({ length: 20 }, (_, i) => [i * 0.25, i === 10 ? -34 : -14]);
  const g2 = sprGeom(600, 230, mk(wide), summary);
  check('osa pojme krajní bod řady', g2.lo < -34, `lo=${g2.lo.toFixed(1)} dB`);
}

console.log('\n═══ 5b. Práh hluboko pod daty NESMÍ roztáhnout osu ═══');
{
  /* REÁLNÁ VADA, kterou uživatel viděl (nahrávka 6,2 s, 5 tónů): práh výpadku
   * vyšel −60,96 dB, tóny ležely mezi −42,7 a −21,7 dB. Osa se počítala
   * z dat VČETNĚ prahu, takže sahala do −65,7 dB — a graf kvůli tomu ukazoval
   * rozsah 48,7 dB místo 26. Krátké tóny pak vedly odspodu a měřily 86–164 px
   * z 182 px plochy, takže každý tón vypadal jako plný sloupec místo křivky.
   *
   * Práh pod daty vzniká u málo tónů: `medián − k·MAD` s MAD ≈ 0 odečte plnou
   * podlahu 3 dB × 2,5… = −61 dB. Žádný tón pak není výpadek, takže práh do
   * rozsahu nepatří. */
  const low = [{ idx: 1, t_start: 1, t_end: 2, dur: 1, note: 'X', f0: 200,
    spr: -39.7, spr_stare: -44.9, ring_ok: true, ring_dropout: false }];
  const sum2 = { ring_threshold: -60.96 };
  const g3 = sprGeom(600, 230, low, sum2);
  check('práh hluboko pod daty osu neroztáhne', g3.lo > -50,
    `lo=${g3.lo.toFixed(1)} dB (data −39,7; práh −60,96)`);
  check('rozsah osy zůstane použitelný (do 30 dB)', g3.hi - g3.lo < 30,
    `${(g3.hi - g3.lo).toFixed(1)} dB`);

  // naopak: práh UVNITŘ dat se do osy dostat MUSÍ — kvůli němu graf existuje
  const mid = [
    { idx: 1, t_start: 1, t_end: 2, dur: 1, note: 'X', f0: 200, spr: -14, spr_stare: -18, ring_ok: true, ring_dropout: false },
    { idx: 2, t_start: 3, t_end: 4, dur: 1, note: 'Y', f0: 200, spr: -24, spr_stare: -28, ring_ok: false, ring_dropout: true },
  ];
  const g4 = sprGeom(600, 230, mid, { ring_threshold: -22 });
  check('práh uvnitř dat osu pojmout MUSÍ', g4.lo <= -22 && g4.hi >= -22,
    `${g4.lo.toFixed(1)}…${g4.hi.toFixed(1)} dB, práh −22`);

  /* Krátký tón bez řady = PLOCHÁ ČÁRKA ve své hodnotě, ne sloupec odspodu.
   * Kdyby se vrátil sloupec, změří se výška přes celou plochu. */
  const rects = [];
  const ctx2 = {
    setTransform() {}, fillText() {}, save() {}, restore() {}, setLineDash() {},
    beginPath() {}, closePath() {}, clip() {}, rect() {}, moveTo() {}, lineTo() {},
    stroke() {}, fill() {}, globalAlpha: 1,
    fillRect(x, y, w2, h2) { rects.push({ x, y, w: w2, h: h2 }); },
  };
  const cv2 = { clientWidth: 600, clientHeight: 230, style: {}, getContext: () => ctx2 };
  const short = [{ idx: 1, t_start: 1, t_end: 1.26, dur: 0.26, note: 'G#3', f0: 210,
    spr: -21.7, spr_stare: -25.1, ring_ok: true, ring_dropout: false }];
  rects.length = 0;
  drawSpr(cv2, short, { ring_threshold: -60.96 });
  const mark = rects.filter(r => r.h <= 4 && r.h >= 2);
  check('krátký tón → plochá čárka ve své hodnotě', mark.length >= 1,
    `${mark.length} čárek, výšky: ${rects.map(r => r.h.toFixed(0)).join(', ')} px`);
  /* Měří se jen ÚZKÉ obdélníky (značky tónů); široké jsou pásma pozadí. */
  const narrow = rects.filter(r => r.w < 100);
  check('krátký tón → žádný sloupec přes celou plochu', narrow.every(r => r.h < 100),
    `nejvyšší značka ${Math.max(...narrow.map(r => r.h)).toFixed(0)} px z 182 px plochy`);
}

console.log('\n═══ 6. Průběh ringu (ringTrend) a hlášení ═══');
{
  /* Na řízeném tónu: první polovina s ringem, druhá bez → drop musí vyjít
   * výrazně záporný. A na stabilním tónu naopak NESMÍ hlásit pokles, jinak
   * by aplikace posílala člověka hledat problém, který v nahrávce není. */
  const SRt = 48000;
  function voice(secs, brightAt) {
    const n = Math.round(secs * SRt);
    const out = new Float64Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const b = brightAt(i / SRt);
      ph += 2 * Math.PI * 220 / SRt;
      let v = 0;
      for (let h = 1; h * 220 < 5200; h++) {
        const fh = h * 220;
        const F = [[700, 1, 110], [1220, 0.5, 130], [2600, b * 0.35, 190]];
        let g = 0; for (const [fc, a, bw] of F) g += a / (1 + ((fh - fc) / bw) ** 2);
        v += Math.max(0.03, g) * Math.sin(h * ph) / Math.sqrt(h);
      }
      out[i] = 0.25 * v;
    }
    return out;
  }

  const falling = analyze(voice(6, t => (t < 3 ? 1 : 0.10)), SRt, { fach: 'tenor' });
  const sF = falling.summary;
  check('tón s poklesem se hlásí jako pokles', sF.ring_trend_drops?.length === 1,
    `${sF.ring_trend_drops?.length} poklesů, nejvíc ${sF.ring_trend_min_db?.toFixed(1)} dB`);
  check('pokles má správný čas i notu',
    sF.ring_trend_drops?.[0]?.note === 'A3' && Number.isFinite(sF.ring_trend_drops?.[0]?.t),
    `${sF.ring_trend_drops?.[0]?.note} v ${sF.ring_trend_drops?.[0]?.t?.toFixed(2)} s`);
  check('počet tónů s řadou se hlásí', sF.ring_trend_tones === 1, `${sF.ring_trend_tones}`);

  const steady = analyze(voice(6, () => 1), SRt, { fach: 'tenor' });
  const sS = steady.summary;
  check('stabilní tón NEHLÁSÍ pokles', sS.ring_trend_drops?.length === 0,
    `${sS.ring_trend_drops?.length} poklesů`);
  check('u stabilního tónu je rozkmit malý (do 2 dB)', sS.ring_trend_median_span < 2,
    `${sS.ring_trend_median_span?.toFixed(2)} dB`);

  /* Kratší tón než 8 bodů řady → ringTrend vrací null, ne nesmysl.
   *
   * PROČ 8: se 4 body vycházela první i poslední čtvrtina z JEDINÉHO bodu,
   * takže se „pokles ringu" hlásil i na tónu, kde šlo o šum. Naměřeno: tón
   * o 0,5 s (4 body řady) se hlásil jako tón s trendem, kdežto s mezí 8 bodů
   * (od ~0,6 s) ne — a to je správně, na 4 bodech se trend měřit nedá. */
  const short = analyze(voice(0.5, () => 1), SRt, { fach: 'tenor' });
  check('krátký tón → žádné trendy (ne nesmyslné číslo)', (short.summary.ring_trend_tones || 0) === 0,
    `${short.summary.ring_trend_tones} tónů s trendem`);
}

console.log(`\n═══ VÝSLEDEK: ${pass} prošlo, ${fail} selhalo ═══`);
process.exit(fail ? 1 : 0);
