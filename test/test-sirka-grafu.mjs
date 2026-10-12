#!/usr/bin/env node
/**
 * Šířka (měřítko) grafu ringu: každý tón musí být v grafu ROZEZNATELNÝ.
 *
 * PROČ (reálná vada, kterou uživatel viděl): nahrál 154 s, 95 tónů, ale do
 * grafu se vešlo jen 599 px → 3,5 px/s. Medián šířky tónu vyšel 2,1 px a z 95
 * tónů jich bylo rozeznatelných 24 — zbytek se slil do souvislé šmouhy.
 * Uživatel to popsal jako „graf je nahuštěný na určitou plochu a neodpovídá
 * nahrávce, skončí dřív než nahrávka“.
 *
 * Staré měřítko počítalo šířku z POČTU tónů (`počet × 6 px`). To platí jen tam,
 * kde se zpívá pořád: nahrávka se 15s pauzou rozprostře čas do šířky a na tóny
 * zbydou 2 px. Nově se měřítko bere z DÉLKY tónu (typický tón = 12 px).
 *
 * Test proto neměří implementaci, ale VÝSLEDEK: kolik px dostane typický tón
 * a kolik tónů je v kresbě oddělených. S původním měřítkem padá.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const mod = await import('file://' + path.join(DIR, '..', 'src', 'charts.js') + '?t=' + Date.now());
const { sprNeededWidth, sprGeom, SPR_H, MAX_CHART_W } = mod;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('\n═══ Šířka grafu ringu: čitelnost tónů ═══\n');

/* ── Tóny jako v reálné nahrávce: 154 s, 95 tónů, medián 0,60 s, dvě dlouhé
 *    pauzy (4,5 s a 15,4 s). Rozložení je pevné (deterministické), aby test
 *    měřil totéž při každém spuštění. ─────────────────────────────────────── */
const DURS = [0.24, 0.85, 2.06, 1.00, 0.39, 0.35, 2.43, 0.23, 0.60, 0.35, 0.47, 0.57, 0.51,
  1.37, 1.09, 1.63, 1.32, 0.43, 1.33, 1.28, 1.37, 0.76, 0.37, 0.27, 1.60, 1.74];
const GAPS = [0.2, 0.5, 0.1, 0.3, 0.7, 0.2, 0.4, 0.1, 0.6, 0.2];
const REAL_T1 = 153.92;
function makeNotes() {
  const out = [];
  let t = 5.97, i = 0;
  while (out.length < 95 && t < 150) {
    const dur = DURS[out.length % DURS.length];
    // kolem 86–90 s a 124–140 s byla v reálné nahrávce pauza
    if (out.length > 0 && out[out.length - 1].t_end < 86.4 && t > 86.4) t = 90.6;
    if (out.length > 0 && out[out.length - 1].t_end < 124.3 && t > 124.3) t = 139.6;
    out.push({ idx: ++i, t_start: t, t_end: t + dur, dur, spr: -20 + (out.length % 7),
      ring_ok: true, ring_dropout: false });
    t += dur + GAPS[out.length % GAPS.length];
  }
  return out;
}
const NOTES = makeNotes();
const SUMMARY = { ring_threshold: -24.8, spr_median: -12.4 };

/* Kolik tónů je v grafu oddělených: tóny blíž než 1,5 px splynou v jeden.
 * Měří se stejnou geometrií, kterou používá kresba. */
function oddelene(width) {
  const g = sprGeom(width, SPR_H, NOTES, SUMMARY, 0, REAL_T1);
  const iv = NOTES.map(n => [g.x(n.t_start), g.x(n.t_end)]);
  const cl = [];
  for (const [a, b] of iv) {
    const last = cl[cl.length - 1];
    if (last && a - last[1] < 1.5) last[1] = Math.max(last[1], b);
    else cl.push([a, b]);
  }
  const widths = cl.map(([a, b]) => b - a).sort((x, y) => x - y);
  return { n: cl.length, med: widths[widths.length >> 1], min: widths[0] };
}

const AVAIL = 330;                                   // okno telefonu
const need = sprNeededWidth(AVAIL, NOTES, REAL_T1);
const W = need || AVAIL;
const g = sprGeom(W, SPR_H, NOTES, SUMMARY, 0, REAL_T1);
const toneW = NOTES.map(n => g.x(n.t_end) - g.x(n.t_start)).sort((a, b) => a - b);
const medToneW = toneW[toneW.length >> 1];
const odd = oddelene(W);

console.log(`  plátno ${W} px (potřeba ${need}), ${(g.plotW / g.t1).toFixed(1)} px/s, ` +
  `medián šířky tónu ${medToneW.toFixed(1)} px, oddělených tónů ${odd.n}/95\n`);

/* ── 1. Na dlouhou nahrávku se graf MUSÍ roztáhnout ───────────────────── */
check('dlouhá nahrávka se posouvá (need > 0)', need > 0, `${need} px`);

/* ── 2. Typický tón dostane tolik px, aby se dal přečíst ──────────────── */
/* 8 px je zvolené měřítko (typický tón = 8 px), medián skutečné šířky vyjde
 * o desetinu nižší kvůli zaokrouhlení geometrie — hlídá se proto 7 px. */
check('medián šířky tónu ≥ 7 px', medToneW >= 7, `${medToneW.toFixed(1)} px`);
check('žádný tón pod 2 px', toneW[0] >= 2, `nejmenší ${toneW[0].toFixed(1)} px`);

/* ── 3. Většina tónů je oddělená (ne jedna šmouha) ────────────────────── */
check('oddělených tónů ≥ 60 z 95', odd.n >= 60, `${odd.n}`);

/* ── 4. Měřítko se bere z délky tónu, ne z počtu ──────────────────────── */
/* Nahrávka se STEJNÝM počtem tónů, ale celá odzpívaná (žádné pauzy) nesmí
 * vyjít užší — jinak se měřítko zase rozpadne. A naopak: pauzy navíc nesmí
 * tóny zmenšit. */
const BEZ_PAUZ = NOTES.map((n, i) => ({ ...n, t_start: 5 + i * 1.5, t_end: 5 + i * 1.5 + n.dur }));
const needBez = sprNeededWidth(AVAIL, BEZ_PAUZ, 5 + 95 * 1.5);
const gBez = sprGeom(needBez, SPR_H, BEZ_PAUZ, SUMMARY, 0, 5 + 95 * 1.5);
const medBez = BEZ_PAUZ.map(n => gBez.x(n.t_end) - gBez.x(n.t_start)).sort((a, b) => a - b)[47];
check('typický tón je dost široký i bez pauz', medBez >= 7, `${medBez.toFixed(1)} px`);

/* ── 5. Krátká nahrávka se NEPOSOUVÁ (jako dřív) ──────────────────────── */
const KRATKE = [{ t_start: 0.2, t_end: 1.0, dur: 0.8, spr: -12 }];
check('krátká nahrávka bez posuvu', sprNeededWidth(600, KRATKE, 2.5) === 0);
check('dvě noty v širokém okně bez posuvu', sprNeededWidth(1200, KRATKE, 30) === 0);

/* ── 6. Strop šířky (paměť telefonu) ──────────────────────────────────── */
const DLOUHE = [];
for (let i = 0; i < 900; i++) DLOUHE.push({ t_start: i, t_end: i + 0.6, dur: 0.6, spr: -15 });
const needD = sprNeededWidth(330, DLOUHE, 900);
check('šířka má strop', needD <= MAX_CHART_W, `${needD} ≤ ${MAX_CHART_W}`);
check('i se stropem je měřítko lepší než 3,5 px/s',
  (needD - 58) / 900 > 3.5, `${((needD - 58) / 900).toFixed(1)} px/s`);

/* ── 7. Osa pořád končí na délce NAHRÁVKY (ne na konci posledního tónu) ── */
check('osa končí na délce nahrávky', Math.abs(g.t1 - REAL_T1) < 1e-9, `${g.t1}`);
check('poslední tón není za okrajem osy', g.x(NOTES[NOTES.length - 1].t_end) <= W - 12 + 1e-6);

/* ── 8. Nesmyslné vstupy nesmí vyrobit šířku ──────────────────────────── */
check('bez tónů → bez posuvu', sprNeededWidth(330, [], 100) === 0);
check('bez délky → bez posuvu', sprNeededWidth(330, NOTES, 0) === 0);
check('tóny bez dur → bez posuvu', sprNeededWidth(330, [{ spr: -12 }], 100) === 0);
check('nula šířky okna → bez posuvu', sprNeededWidth(0, NOTES, 100) === 0);

console.log(`\n${pass} prošlo, ${fail} selhalo\n`);
process.exit(fail ? 1 : 0);
