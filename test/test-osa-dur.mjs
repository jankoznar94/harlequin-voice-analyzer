#!/usr/bin/env node
/**
 * Osa grafu musí končit na DÉLCE NAHRÁVKY, ne na konci posledního tónu.
 *
 * PROČ (reálná vada, kterou uživatel viděl): nahrál tón, na grafu se objevila
 * křivka, ale ukazatel času dojel na konec osy DŘÍV, než skončil přehrávač.
 * Naměřeno v prohlížeči na 72,6s nahrávce: přehrávač hlásil 1:12 (72,58 s),
 * ale `t1` grafu ringu bylo 71,43 s — přesně konec posledního tónu. Rozdíl
 * 1,15 s je dozvuk na konci; u nahrávky s delším dozvukem je chyba větší.
 * Spektrogram i přehrávač jely do délky souboru, takže se dvě osy v jedné
 * obrazovce rozcházely.
 *
 * Test hlídá obojí: že se délka POUŽIJE, a že se staré chování (bez délky)
 * nezměnilo — na něm stojí dřívější volající a testy.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const mod = await import('file://' + path.join(DIR, '..', 'src', 'charts.js') + '?t=' + Date.now());
const { sprGeom, f1Geom, f1Notes, drawSpr, drawSprHead, drawF1Head,
        SPR_H, SPEC_H, F1_H } = mod;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('\n═══ Osa grafu vs. délka nahrávky ═══\n');

const W = 731, DUR = 72.58, LAST_END = 71.43;

/* Tóny jako v reálné nahrávce: poslední končí na 71,43 s, ale soubor má 72,58. */
const NOTES = [
  { t_start: 0.2, t_end: 1.1, f0: 220, spr: -14, ring_ok: true },
  { t_start: 10.0, t_end: 14.0, f0: 196, spr: -12, ring_ok: true,
    spr_series: [[0, -12], [0.5, -13], [1.0, -12.5]] },
  { t_start: 70.5, t_end: LAST_END, f0: 165, spr: -15, ring_ok: true },
];
const SUMMARY = { ring_threshold: -20, spr_median: -13 };
const SPR_PAD_L = 46, SPR_PAD_R = 12;

/* ── 1. Délka se POUŽIJE jako konec osy ─────────────────────────────── */

const gDur = sprGeom(W, SPR_H, NOTES, SUMMARY, 0, DUR);
check('s délkou: osa končí na délce nahrávky', Math.abs(gDur.t1 - DUR) < 1e-9,
  `t1=${gDur.t1.toFixed(2)} s, očekáváno ${DUR}`);
check('poslední tón NEleží na konci osy (je vidět dozvuk za ním)',
  Math.abs(gDur.t1 - LAST_END) > 1.0, `rozdíl ${(gDur.t1 - LAST_END).toFixed(2)} s`);
check('pravý okraj osy odpovídá času DUR',
  Math.abs(gDur.x(DUR) - (SPR_PAD_L + gDur.plotW)) < 1e-9,
  `x(DUR)=${gDur.x(DUR).toFixed(1)}, okraj=${(SPR_PAD_L + gDur.plotW).toFixed(1)}`);
check('tóny zůstaly uvnitř osy (nic se neořízlo)',
  NOTES.every(n => gDur.x(n.t_end) <= SPR_PAD_L + gDur.plotW + 1e-9));

/* ── 2. Staré chování bez délky se NESMÍ změnit ─────────────────────── */

const gOld = sprGeom(W, SPR_H, NOTES, SUMMARY, 0);
check('bez délky: osa končí posledním tónem (staré chování drží)',
  Math.abs(gOld.t1 - LAST_END) < 1e-9, `t1=${gOld.t1.toFixed(2)}`);

/* ── 3. Délka MENŠÍ než data nesmí tóny vystrčit mimo osu ───────────── */

const gShort = sprGeom(W, SPR_H, NOTES, SUMMARY, 0, 5.0);
check('kratší délka než data → osa se roztáhne na data',
  Math.abs(gShort.t1 - LAST_END) < 1e-9,
  `t1=${gShort.t1.toFixed(2)} (délka 5 s, poslední tón ${LAST_END} s)`);

/* ── 4. Roundtrip čas → pixel → čas ─────────────────────────────────── */

{
  /* POZOR na souřadnicové systémy: `x()` vrací souřadnici pro KRESBU (posuv
   * odečtený), kdežto `timeAtX()`/`pxAtTime()` pracují s pixelem PLÁTNA.
   * Roundtrip se proto zkouší při posuvu 0, což je přesně stav, kdy klik
   * v aplikaci počítá `px = clientX - rect.left + 0` — tedy to, co dělá
   * `onChartClick` na nescrollovaném grafu. Chování posuvu má vlastní,
   * měřením ověřený test (`test-playhead.mjs`, `kontrola-scroll.html`)
   * a moje změna `t1` se ho nedotýká. */
  const g0 = sprGeom(W, SPR_H, NOTES, SUMMARY, 0, DUR);
  let worst = 0;
  for (const t of [0, 1, 20, 40, 71, DUR]) {
    worst = Math.max(worst, Math.abs(g0.timeAtX(g0.x(t)) - t));
  }
  check('roundtrip čas → pixel → čas', worst < 1e-9, `odchylka ${worst.toExponential(1)} s`);

  check('pxAtTime(40) = x(40) při posuvu 0',
    Math.abs(g0.pxAtTime(40) - g0.x(40)) < 1e-9,
    `pxAtTime=${g0.pxAtTime(40).toFixed(1)}, x=${g0.x(40).toFixed(1)}`);
  check('klik na ten pixel trefí 40 s',
    Math.abs(g0.timeAtX(g0.pxAtTime(40)) - 40) < 1e-9,
    `timeAtX=${g0.timeAtX(g0.pxAtTime(40)).toFixed(3)} s`);

  /* S posuvem se kresba posune o offX — to je vlastnost, na které stojí
   * `followSprScroll`. Ověřuje se jen posun, ne roundtrip (ten má vlastní test). */
  const offX = 300;
  const gp = sprGeom(W, SPR_H, NOTES, SUMMARY, offX, DUR);
  check('s posuvem se kresba posune přesně o offX',
    Math.abs((g0.x(40) - gp.x(40)) - offX) < 1e-9,
    `posun ${(g0.x(40) - gp.x(40)).toFixed(1)} px, očekáváno ${offX}`);
  check('posuv nemění konec osy ani měřítko', Math.abs(gp.t1 - g0.t1) < 1e-9);
}

/* ── 5. Graf ladění: stejná oprava ──────────────────────────────────── */

/* POZOR — `f1Notes` filtruje podle `f1_tuning_relevant`, ne podle `f1_ok`.
 * Když se sem dá jiné pole, `f1Geom` vrátí null a test hlásí chybu kódu,
 * která vznikla v testu. */
const F1NOTES = [
  { t_start: 0.5, t_end: 2.0, f0: 440, f1: 800, f1_f0_err_pct: 3, f1_tuning_relevant: true },
  { t_start: 30.0, t_end: 66.0, f0: 523, f1: 900, f1_f0_err_pct: 5, f1_tuning_relevant: true },
];
const rel = f1Notes(F1NOTES);
check('f1Notes vybral oba tóny (test má správná pole)',
  rel.length === 2, `vybráno ${rel.length}`);
const g1 = f1Geom(W, F1_H, rel, DUR);
check('ladění: osa končí na délce nahrávky', g1 && Math.abs(g1.t1 - DUR) < 1e-9,
  g1 ? `t1=${g1.t1.toFixed(2)}` : 'null');
const g1old = f1Geom(W, F1_H, rel);
check('ladění: bez délky staré chování drží', g1old && Math.abs(g1old.t1 - 66.0) < 1e-9,
  g1old ? `t1=${g1old.t1.toFixed(2)}` : 'null');

/* ── 6. Ukazatel: konec nahrávky musí být na konci osy ──────────────── */

/**
 * Mock plátna pro překryvné plátno — `drawSprHead`/`drawF1Head` kreslí jen čáru,
 * takže se dá zachytit, KAM ji nakreslily. Klín i čára jdou na stejné x.
 */
function mockOverlay() {
  const lines = [];
  const ctx = {
    setTransform() {}, clearRect() {}, fillText() {},
    beginPath() {}, moveTo(x, y) { this._x = x; this._y = y; },
    lineTo(x, y) { lines.push([this._x, this._y, x, y]); },
    stroke() {}, fill() {}, closePath() {}, save() {}, restore() {},
    setLineDash() {}, fillRect() {}, rect() {}, clip() {},
    strokeStyle: '', fillStyle: '', lineWidth: 1, globalAlpha: 1, lineJoin: '',
  };
  const canvas = {
    width: 0, height: 0, clientWidth: W, clientHeight: SPR_H,
    parentElement: { clientWidth: W },
    getContext: () => ctx,
  };
  return { canvas, lines };
}
globalThis.window = { devicePixelRatio: 1 };

{
  const { canvas, lines } = mockOverlay();
  drawSprHead(canvas, NOTES, SUMMARY, DUR, { duration: DUR });
  /* Bere se SVISLÁ čára (x1 === x2), ne maximum ze všech tahů — klín nahoře
   * jde o 5 px dál a sonda by měřila jeho špičku, ne polohu ukazatele. */
  const vertical = lines.filter(l => Math.abs(l[0] - l[2]) < 1e-9);
  const lineX = vertical.length ? vertical[0][0] : NaN;
  const rightEdge = SPR_PAD_L + (W - SPR_PAD_L - SPR_PAD_R);
  check('ukazatel na konci nahrávky sedí na pravém okraji osy',
    Math.abs(lineX - rightEdge) < 1.5, `čára na ${lineX}, okraj ${rightEdge}`);
  check('ukazatel se s délkou posunul doprava (dřív skončil o ~12 px vlevo)',
    lineX > SPR_PAD_L + (W - SPR_PAD_L - SPR_PAD_R) * 0.98, `čára na ${lineX}`);
}

{
  /* Bez délky musí ukazatel zůstat tam, kde byl — jinak by se rozbil
   * spektrogram (ten si délku počítá sám) i starší volající. */
  const { canvas, lines } = mockOverlay();
  drawSprHead(canvas, NOTES, SUMMARY, LAST_END, {});
  const vertical = lines.filter(l => Math.abs(l[0] - l[2]) < 1e-9);
  const lineX = vertical.length ? vertical[0][0] : NaN;
  const rightEdge = SPR_PAD_L + (W - SPR_PAD_L - SPR_PAD_R);
  check('bez délky ukazatel na konci posledního tónu = pravý okraj',
    Math.abs(lineX - rightEdge) < 1.5, `čára na ${lineX}`);
  /* A s délkou musí být na STEJNÉM místě, protože poslední tón je na konci
   * osy i tehdy — délka osu jen prodlouží za něj, nezkrátí. Kontroluje se
   * proto i to, že se čára neposunula vlevo. */
  const { canvas: c2, lines: l2 } = mockOverlay();
  drawSprHead(c2, NOTES, SUMMARY, LAST_END, { duration: DUR });
  const v2 = l2.filter(l => Math.abs(l[0] - l[2]) < 1e-9);
  check('se stejnou délkou je ukazatel na stejném čase jinde než bez ní',
    v2.length && Math.abs(v2[0][0] - lineX) > 1.0,
    `bez délky ${lineX}, s délkou ${v2.length ? v2[0][0] : '—'}`);
}

console.log(`\n═══ VÝSLEDEK: ${pass} prošlo, ${fail} selhalo ═══`);
process.exit(fail ? 1 : 0);
