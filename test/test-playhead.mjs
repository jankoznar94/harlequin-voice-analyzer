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
const { sprGeom, specGeom, drawSpr, drawPlayhead, drawSprHead, drawSpecHead, clearHead } = mod;

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
    fillRect(x, y, w, h) { ops.fills.push([x, y, w, h]); },
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

console.log(`\n${fail === 0 ? '✓' : '✗'} Ukazatel přehrávání: ${pass} prošlo, ${fail} selhalo\n`);
process.exit(fail ? 1 : 0);
