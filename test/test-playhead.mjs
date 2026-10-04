#!/usr/bin/env node
/**
 * Test ukazatele přehrávání (playhead) a geometrie grafů.
 *
 * Co se tu hlídá a proč:
 *
 *  1. **Klepnutí do grafu musí trefit čas.** Když se měřítko osy počítá na dvou
 *     místech (jednou pro vykreslení, podruhé pro klik), stačí posunout okraj
 *     grafu a klikání začne hledat o kus vedle — a na první pohled to není
 *     vidět, protože čára se pořád kreslí „někam". Proto je geometrie jedna
 *     (`sprGeom`) a testuje se roundtrip čas → pixel → čas.
 *
 *  2. **Ukazatel musí sedět na graf, ne vedle.** Spektrogram kreslí hranice tónů
 *     sám, podle svých okrajů; ukazatel se kreslí přes `specGeom`. Test porovnává
 *     obojí — kdyby se okraje rozešly, čára by ukazovala na jiný tón, než jaký
 *     zní.
 *
 *  3. **Ukazatel se nesmí kreslit mimo plochu grafu** (před začátkem, za koncem).
 *
 * V Node není prohlížeč, takže canvas je mock, který si zapisuje, co se na něj
 * kreslí.
 */
globalThis.window = { devicePixelRatio: 2 };   // testujeme i HiDPI
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData(img) { globalThis.__off = img; } }) }),
};

const mod = await import('../src/charts.js');
const { sprGeom, specGeom, drawSpr, drawPlayhead, drawSprHead, drawSpecHead,
        clearHead, f1Geom, f1Notes, drawF1Head, drawF1 } = mod;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

/** Mock canvasu, který si pamatuje tahy (moveTo/lineTo) i výplně. */
function mockCanvas(cssW, cssH) {
  const ops = { moves: [], lines: [], strokes: 0, clears: 0, fills: [] };
  let cur = null;
  const ctx = {
    setTransform() {}, fillText() {}, save() {}, restore() {},
    translate() {}, rotate() {}, setLineDash() {}, arc() {},
    beginPath() { cur = null; },
    closePath() {},
    rect() {}, clip() {},
    moveTo(x, y) { cur = { x, y }; ops.moves.push({ x, y }); },
    lineTo(x, y) { if (cur) ops.lines.push({ from: cur, to: { x, y } }); },
    stroke() { ops.strokes++; },
    fill() { ops.filledPaths = (ops.filledPaths || 0) + 1; },
    fillRect(x, y, w, h) { ops.fills.push([x, y, w, h]); ops.fillsStyle = ops.fillsStyle || []; ops.fillsStyle.push({ x, y, w, h, style: this.fillStyle }); },
    clearRect() { ops.clears++; },
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(img) { globalThis.__off = img; },
    drawImage() {},
  };
  const canvas = { clientWidth: cssW, clientHeight: cssH, style: {}, getContext: () => ctx, width: 0, height: 0 };
  return { canvas, ops };
}

/** Vzorek tónů — SPR rozložené tak, aby vznikl i práh výpadku. */
const NOTES = [
  { t_start: 0.0, t_end: 1.0, spr: -12.0, ring_ok: true },
  { t_start: 1.2, t_end: 2.4, spr: -13.5, ring_ok: true },
  { t_start: 2.6, t_end: 4.0, spr: -22.0, ring_ok: false },
  { t_start: 4.2, t_end: 5.5, spr: -12.5, ring_ok: true },
  { t_start: 5.7, t_end: 7.0, spr: -13.0, ring_ok: true },
  { t_start: 7.2, t_end: 9.0, spr: -23.0, ring_ok: false },
];
const SUMMARY = { ring_threshold: -17.5, reason: '' };
const W = 800, H = 230;

/* ── tóny pro graf ladění ────────────────────────────────────────────────
 * Graf ladění kreslí jen tóny od G4 výš, ale jeho osa X je ČAS — stejně jako
 * u grafu ringu a spektrogramu. Testy níž hlídají právě to: že ukazatel jede
 * plynule po čase a klik trefí přesné místo, ne že „stojí na tónu".
 */
const F1_NOTES = [
  { t_start: 0.0, t_end: 1.0, f1_tuning_relevant: true, f1_f0_err_pct: 4.0, f1_tuned: true, note: 'A4' },
  { t_start: 1.2, t_end: 2.4, f1_tuning_relevant: true, f1_f0_err_pct: 12.0, f1_tuned: false, note: 'H4' },
  { t_start: 2.6, t_end: 4.0, f1_tuning_relevant: true, f1_f0_err_pct: 30.0, f1_tuned: false, note: 'C5' },
  { t_start: 4.2, t_end: 5.5, f1_tuning_relevant: false, f1_f0_err_pct: NaN, note: 'A3' },   // pod G4 — nekreslí se
  { t_start: 5.7, t_end: 9.0, f1_tuning_relevant: true, f1_f0_err_pct: 6.0, f1_tuned: true, note: 'D5' },
];

console.log('\n═══ Geometrie grafu ringu ═══\n');

const g = sprGeom(W, H, NOTES, SUMMARY);
check('geometrie se spočítá z tónů', !!g);
check('osa X začíná na levém okraji grafu', g.x(0) === g.padL, `x(0)=${g.x(0)} padL=${g.padL}`);
check('osa X končí na pravém okraji grafu',
  Math.abs(g.x(g.t1) - (g.padL + g.plotW)) < 1e-9, `x(t1)=${g.x(g.t1)} vs ${g.padL + g.plotW}`);
check('konec nahrávky = konec posledního tónu', g.t1 === 9.0, `t1=${g.t1}`);
check('rozsah dB sedí na data', g.lo < -23 && g.hi > -12, `${g.lo.toFixed(1)}…${g.hi.toFixed(1)} dB`);

// Roundtrip: pixel → čas → pixel. Tohle je přesně to, co dělá klepnutí do grafu.
{
  let worst = 0;
  for (const t of [0, 0.7, 2.6, 5, 8.9, 9.0]) {
    worst = Math.max(worst, Math.abs(g.timeAtX(g.x(t)) - t));
  }
  check('klepnutí do grafu vrátí stejný čas (roundtrip)', worst < 1e-9,
    `největší odchylka ${worst.toExponential(1)} s`);
}
check('klepnutí vlevo od osy dá záporný čas (app si to ořeže)',
  g.timeAtX(g.padL - 30) < 0, `${g.timeAtX(g.padL - 30).toFixed(2)} s`);
check('bez měřitelných tónů geometrie neexistuje',
  sprGeom(W, H, [{ t_start: 0, t_end: 1, spr: NaN }], SUMMARY) === null);

console.log('\n═══ Kresba ukazatele ═══\n');

// drawPlayhead musí udělat svislou čáru přes celou výšku grafu.
{
  const { canvas, ops } = mockCanvas(W, H);
  const ctx = canvas.getContext('2d');
  drawPlayhead(ctx, g, 4.5);
  const vert = ops.lines.find(l => l.from.y === g.padT && l.to.y === g.padT + g.plotH);
  check('ukazatel je svislá čára přes plochu grafu', !!vert);
  check('čára stojí na čase 4,5 s', vert && Math.abs(vert.from.x - (g.x(4.5))) < 1,
    vert ? `x=${vert.from.x} vs ${g.x(4.5).toFixed(1)}` : '—');
  check('ukazatel má klín nahoře (výplň)', ops.filledPaths === 1);
}

// Mimo plochu grafu se nesmí kreslit nic — jinak by čára přetekla do osy Y.
{
  const { canvas, ops } = mockCanvas(W, H);
  drawPlayhead(canvas.getContext('2d'), g, 99);
  check('za koncem nahrávky se ukazatel nekreslí', ops.strokes === 0, `tahy: ${ops.strokes}`);
}
{
  const { canvas, ops } = mockCanvas(W, H);
  drawPlayhead(canvas.getContext('2d'), g, -5);
  check('ukazatel se neořezává do záporného času (kreslí se na 0)',
    ops.strokes === 1 && Math.abs(ops.moves[0].x - g.padL) < 1, `x=${ops.moves[0]?.x}`);
}

// Souřadnice musí být čísla. Regrese: specGeom vracel `plotT` místo `padT`,
// takže drawPlayhead dostal NaN — čára se „nakreslila" mimo plátno a v UI
// prostě nebyla, bez jakékoli chyby v konzoli.
{
  const { canvas, ops } = mockCanvas(W, H);
  const sg = specGeom(W, 300, 9.0);
  const before = ops.lines.length;
  drawPlayhead(canvas.getContext('2d'), sg, 4.5);
  const vert = ops.lines.slice(before).find(l => l.from.y === sg.padT && l.to.y === sg.padT + sg.plotH);
  check('specGeom má padT/padH (ne jiný název)',
    Number.isFinite(sg.padT) && Number.isFinite(sg.padH = sg.padT + sg.plotH),
    `padT=${sg.padT}`);
  check('ukazatel nad spektrogramem má platné souřadnice', !!vert,
    vert ? `y ${vert.from.y}→${vert.to.y}` : 'čára chybí (NaN souřadnice?)');
}

console.log('\n═══ drawSpr vrací geometrii pro klik ═══\n');

{
  const { canvas, ops } = mockCanvas(W, H);
  const gr = drawSpr(canvas, NOTES, SUMMARY, 3.0);
  check('drawSpr vrátí geometrii', !!gr && typeof gr.timeAtX === 'function');
  check('ukazatel se dokreslil do stejného grafu', ops.strokes > 0);
  check('geometrie sedí na stejné rozměry', gr.padL === g.padL && gr.plotW === g.plotW);
}
{
  const { canvas, ops } = mockCanvas(W, H);
  const gr = drawSpr(canvas, NOTES, SUMMARY);   // bez ukazatele
  check('bez ukazatele se kreslí jen mřížka a sloupce', gr !== null);
  check('drawSpr bez tónů vrátí null',
    drawSpr(canvas, [{ t_start: 0, t_end: 1, spr: NaN }], SUMMARY) === null);
}

console.log('\n═══ Spektrogram: ukazatel sedí na hranice tónů ═══\n');

const DUR = 9.0, SPEC_W = 800, SPEC_H = 300;
const sg = specGeom(SPEC_W, SPEC_H, DUR);
check('specGeom: čas 0 je na levém okraji', sg.x(0) === sg.padL);
check('specGeom: konec nahrávky je na pravém okraji',
  Math.abs(sg.x(DUR) - (sg.padL + sg.plotW)) < 1e-9);
{
  let worst = 0;
  for (const t of [0, 1.2, 2.6, 5, 7.2, 9]) worst = Math.max(worst, Math.abs(sg.timeAtX(sg.x(t)) - t));
  check('specGeom roundtrip čas → pixel → čas', worst < 1e-9, `odchylka ${worst.toExponential(1)} s`);
}

// PARITA: drawSpec kreslí hranici tónu na x = padL + (t/total)*plotW. Ukazatel
// musí použít stejné x — jinak čára ukazuje na jiný tón, než jaký právě zní.
{
  const { canvas, ops } = mockCanvas(SPEC_W, SPEC_H);
  const samples = new Float64Array(Math.round(DUR * 44100));
  mod.drawSpec(canvas, samples, 44100, NOTES);
  const boundaries = ops.moves
    .filter(m => m.y === sg.padT)
    .map(m => m.x);
  const worst = Math.max(...NOTES.map(n =>
    Math.min(...boundaries.map(b => Math.abs(b - sg.x(n.t_start))))));
  check('ukazatel leží na stejných x jako hranice tónů ve spektrogramu',
    worst < 1.5, `největší odchylka ${worst.toFixed(1)} px`);
}

console.log('\n═══ Překryvná plátna ═══\n');

{
  const { canvas, ops } = mockCanvas(W, H);
  drawSprHead(canvas, NOTES, SUMMARY, 2.0);
  check('drawSprHead vyčistí plátno před kresbou', ops.clears === 1);
  check('drawSprHead nakreslí ukazatel', ops.strokes === 1);
  check('drawSprHead nastaví buffer v device px',
    canvas.width === Math.round(W * 2) && canvas.height === Math.round(H * 2),
    `${canvas.width}×${canvas.height}`);
}
{
  const { canvas, ops } = mockCanvas(SPEC_W, SPEC_H);
  drawSpecHead(canvas, DUR, 3.3);
  check('drawSpecHead vyčistí plátno a nakreslí čáru', ops.clears === 1 && ops.strokes === 1);
}
{
  const { canvas, ops } = mockCanvas(W, H);
  clearHead(canvas, H);
  check('clearHead smaže plátno a nic nekreslí', ops.clears === 1 && ops.strokes === 0);
}
{
  // Bez měřitelných tónů nesmí drawSprHead spadnout (graf hlásí „nelze měřit").
  const { canvas, ops } = mockCanvas(W, H);
  drawSprHead(canvas, [{ t_start: 0, t_end: 1, spr: NaN }], SUMMARY, 1);
  check('drawSprHead bez měřitelných tónů nic nekreslí a nespadne', ops.strokes === 0);
}

console.log('\n═══ Barvy sloupců: výpadek ≠ vyřazený tón ═══\n');

/* ⚠️ REGRESE, KTEROU UŽIVATEL VIDĚL: tón s platným SPR, který analýza VYŘADILA
 * (moc krátký / moc tichý), má v datech `ring_ok === false` — a kreslil se proto
 * stejně červeně jako skutečný výpadek ringu. Uživatel pak viděl „červený" tón
 * s SPR −9,7 dB, tedy na úrovni profesionála, a nechápal, proč je červený.
 * Naměřeno na nahrávce: 1 skutečný výpadek, ale 10 červených sloupců.
 * Rozhodovat musí `ring_dropout`, ne `!ring_ok`. */
{
  const mix = [
    { t_start: 0.0, t_end: 1.0, spr: -12.0, ring_ok: true,  ring_dropout: false },
    { t_start: 1.2, t_end: 2.4, spr: -9.7,  ring_ok: false, ring_dropout: false },  // vyřazený, SPR jako profesionál
    { t_start: 2.6, t_end: 4.0, spr: -24.0, ring_ok: false, ring_dropout: true  },  // skutečný výpadek
  ];
  const { canvas, ops } = mockCanvas(W, H);
  const gr = drawSpr(canvas, mix, SUMMARY);
  check('drawSpr s mixem tónů vrátí geometrii', !!gr);

  // Sloupce se poznají podle šířky ≤ 18 px; hledáme barvu na nich.
  const bars = (ops.fillsStyle || []).filter(f => f.w <= 18 && f.h > 0);
  const reds = bars.filter(f => f.style === '#b5675e');
  const greys = bars.filter(f => f.style === '#6f6862');
  check('červeně je jen SKUTEČNÝ výpadek (1 ze 3 tónů)', reds.length === 1,
    `${reds.length} červených z ${bars.length} sloupců`);
  check('vyřazený tón (SPR −9,7 dB) je neutrální šedý, ne červený', greys.length === 1,
    `šedých: ${greys.length} — barvy: ${bars.map(f => f.style).join(' ')}`);
}
{
  // Skutečný výpadek červený zůstat MUSÍ — jinak by oprava jen schovala vadu.
  const jenVypadek = [{ t_start: 0, t_end: 1, spr: -24.0, ring_ok: false, ring_dropout: true }];
  const { canvas, ops } = mockCanvas(W, H);
  drawSpr(canvas, jenVypadek, SUMMARY);
  const bars = (ops.fillsStyle || []).filter(f => f.w <= 18 && f.h > 0);
  check('skutečný výpadek ringu se pořád kreslí červeně',
    bars.some(f => f.style === '#b5675e'), bars.map(f => f.style).join(' '));
}

console.log('\n═══ Graf ladění: osa je čas, ukazatel i klik sedí na tón ═══\n');

{
  const rel = f1Notes(F1_NOTES);
  check('graf ladění bere jen tóny od G4 výš', rel.length === 4,
    `${rel.length} z ${F1_NOTES.length}`);

  const g1 = f1Geom(W, 200, rel);
  check('geometrie grafu ladění se spočítá', !!g1);
  check('bez tónů od G4 geometrie neexistuje (graf hlásí „nelze hodnotit")',
    f1Geom(W, 200, f1Notes(NOTES)) === null);
  check('osa X končí na konci posledního tónu (9 s)', g1.t1 === 9.0, `t1=${g1.t1}`);
  check('osa X začíná na levém okraji', g1.x(0) === g1.padL);
  check('osa X končí na pravém okraji',
    Math.abs(g1.x(g1.t1) - (g1.padL + g1.plotW)) < 1e-9);

  // Roundtrip jako u ostatních grafů — přesně tohle dělá klepnutí do grafu.
  let worst = 0;
  for (const t of [0, 0.7, 2.6, 5, 8.9, 9.0]) worst = Math.max(worst, Math.abs(g1.timeAtX(g1.x(t)) - t));
  check('klepnutí do grafu ladění vrátí stejný čas (roundtrip)', worst < 1e-9,
    `největší odchylka ${worst.toExponential(1)} s`);

  // Ukazatel musí stát na TÓNU, který zní, ne mezi tóny — jinak by čára
  // ukazovala do místa, kde se nic nezpívá.
  const onNote = (t) => rel.some(n => t >= n.t_start && t <= n.t_end);
  {
    const px = g1.x(3.0);
    const t = g1.timeAtX(px);
    check('ukazatel v čase 3 s stojí na tónu C5 (2,6–4,0 s)', onNote(t) && t > 2.6 && t < 4.0,
      `${t.toFixed(2)} s`);
  }
  check('tón, který se nehodnotí, se do grafu nebere (čtvrtý hodnocený je D5)',
    rel[3].note === 'D5', rel.map(n => n.note).join(' '));

  // Ukazatel musí mít platné souřadnice i na plátně — regrese, kdy `specGeom`
  // vracel `plotT` místo `padT` a čára se „nakreslila" mimo plátno bez chyby.
  const { canvas, ops } = mockCanvas(W, 200);
  drawF1Head(canvas, F1_NOTES, 3.0);
  const vert = ops.lines.find(l => l.from.y === g1.padT && l.to.y === g1.padT + g1.plotH);
  check('ukazatel v grafu ladění má platné souřadnice', !!vert,
    vert ? `x=${vert.from.x}` : 'čára chybí (NaN?)');
  check('ukazatel v grafu ladění sedí na čas 3 s', vert && Math.abs(vert.from.x - g1.x(3.0)) < 1,
    `x=${vert.from.x} vs ${g1.x(3.0).toFixed(1)}`);
  check('mimo plochu grafu se ukazatel ladění nekreslí',
    (() => { const m = mockCanvas(W, 200); drawF1Head(m.canvas, F1_NOTES, 99); return m.ops.strokes === 0; })());

  // Graf samotný: drawF1 musí vrátit geometrii (app ji používá pro klik).
  const { canvas: c2, ops: o2 } = mockCanvas(W, 200);
  const gr = drawF1(c2, F1_NOTES, null);
  check('drawF1 vrací geometrii pro klik', !!gr && typeof gr.timeAtX === 'function');
  const bars = (o2.fills || []).filter(f => f[3] > 0 && f[2] <= 18);
  check('sloupců je tolik, kolik je hodnocených tónů', bars.length === rel.length,
    `${bars.length} sloupců na ${rel.length} tónů`);
  /* Sloupec musí stát na SVÉM TÓNU na časové ose — ne na rovnoměrném rozestupu.
   * ⚠️ Šířka sloupce se kvůli čitelnosti zastavuje na 18 px, takže z šířky se
   * rozdíl nepozná; rozhoduje POLOHA. Poslední tón (D5, 5,7 s z 9 s) musí být
   * vpravo za polovinou plochy, ale ne na jejím konci — při rovnoměrném
   * rozestupu by seděl až u pravého okraje (naměřeno: 787 px místo 512 px). */
  const last = bars.reduce((a, b) => (b[0] > a[0] ? b : a), bars[0]);
  check('poslední sloupec stojí na svém čase (5,7 s), ne u pravého okraje',
    Math.abs(last[0] - g1.x(5.7)) < 12,
    `x=${last[0].toFixed(0)} vs čas 5,7 s na ${g1.x(5.7).toFixed(0)}, pravý okraj ${(g1.padL + g1.plotW).toFixed(0)}`);
  check('první sloupec stojí na začátku nahrávky (tón A4 od 0 s)',
    Math.abs(bars[0][0] - g1.x(0)) < 12, `x=${bars[0][0].toFixed(0)}`);
}

console.log(`\n${fail === 0 ? '✓' : '✗'} Ukazatel přehrávání: ${pass} prošlo, ${fail} selhalo\n`);
process.exit(fail ? 1 : 0);