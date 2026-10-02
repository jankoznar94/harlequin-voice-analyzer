#!/usr/bin/env node
/**
 * Regresní test spektrogramu (drawSpec).
 *
 * Chytá dvě chyby, které se v prohlížeči projeví jako „graf je šedý a data
 * jsou sražená do malého čtverce vlevo nahoře":
 *
 *  1. `ctx.putImageData(img, x, y)` bere (x, y) jako zdroj v bufferu, ne jako
 *     cíl na plátně → obraz se vloží do levého horního rohu a ořízne.
 *  2. Pevný rozsah dB (−100…−10) bez normalizace na špičku nahrávky → celý
 *     obraz je buď sytý, nebo tmavý, ať je nahrávka nahlas nebo potichu.
 *
 * Test používá mock canvasu — v Node prohlížeč není.
 */
globalThis.window = { devicePixelRatio: 2 };   // testujeme i HiDPI
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData(img) { globalThis.__off = img; } }) }),
};

const mod = await import('../src/charts.js');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

function mockCanvas(cssW, cssH) {
  const calls = { blits: [], fills: [] };
  const ctx = {
    setTransform() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, save() {}, restore() {}, translate() {}, rotate() {}, setLineDash() {},
    fillRect(x, y, w, h) { calls.fills.push([x, y, w, h]); },
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(img, x, y) { calls.blits.push({ img, x, y, via: 'putImageData' }); },
    drawImage(off, x, y, dw, dh) { calls.blits.push({ img: globalThis.__off, x, y, dw, dh, via: 'drawImage', w: off.width, h: off.height }); },
  };
  return { canvas: { clientWidth: cssW, clientHeight: cssH, style: {}, getContext: () => ctx }, calls };
}

/** Syntetický tón s formantovou obálkou — nezávisí na externím WAV. */
function voice(durS, sr, f0, level, formantHz = 2800) {
  const n = Math.round(durS * sr);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (let h = 1; h < 40; h++) {
      const fh = f0 * h;
      if (fh > sr / 2 - 100) break;
      const amp = (1 / h) * (Math.exp(-((fh - formantHz) ** 2) / (2 * 900 ** 2))
        + 0.35 * Math.exp(-((fh - 700) ** 2) / (2 * 400 ** 2)));
      s += amp * Math.sin(2 * Math.PI * fh * t);
    }
    out[i] = level * s * Math.exp(-3 * t);
  }
  return out;
}

function concat(parts, gapS, sr) {
  const gap = new Float64Array(Math.round(gapS * sr));
  const total = parts.reduce((a, p) => a + p.length, 0) + gap.length * (parts.length - 1);
  const out = new Float64Array(total);
  let o = 0;
  parts.forEach((p, i) => {
    if (i) { out.set(gap, o); o += gap.length; }
    out.set(p, o); o += p.length;
  });
  return out;
}

const SR = 44100;
const H = 300, PADL = 42, PADT = 12, PADR = 12, PADB = 26;
const DPR = globalThis.window.devicePixelRatio;

/** Vykreslí spektrogram a vrátí rozbor pixelů. */
function render(samples, width = 800) {
  const { canvas, calls } = mockCanvas(width, H);
  mod.drawSpec(canvas, samples, SR, [{ t_start: 0.5, t_end: 1.0 }]);
  check('  obraz vložen přes drawImage (offset i měřítko v CSS px)',
    calls.blits.length === 1 && calls.blits[0].via === 'drawImage');
  const { img, x, y, dw, dh, w: offW } = calls.blits[0];
  const plotW = Math.round(width - PADL - PADR), plotH = Math.round(H - PADT - PADB);
  let minR = 255, maxR = 0, blank = 0, sat = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const R = img.data[i];
    minR = Math.min(minR, R); maxR = Math.max(maxR, R);
    if (R <= 27) blank++;
    if (R >= 215) sat++;
  }
  const tot = img.data.length / 4;
  return { img, x, y, dw, dh, offW, plotW, plotH, minR, maxR, blankPct: 100 * blank / tot, satPct: 100 * sat / tot };
}

console.log('\n═══ Spektrogram: umístění obrazu ═══\n');
console.log(`  (devicePixelRatio v testu = ${DPR})`);

const mel = concat([voice(0.5, SR, 196, 0.30), voice(0.5, SR, 247, 0.30), voice(0.5, SR, 294, 0.30)], 0.25, SR);
const r1 = render(mel);
// Hlavní regrese: buffer musí být v device px a drawImage ho musí roztáhnout na
// plotW × plotH v CSS px. Dřív měl buffer velikost plotW × plotH a na displeji
// s dpr = 2 vyplnil jen levou horní čtvrtinu grafu.
check('buffer má velikost plochy v DEVICE px',
  r1.img.width === Math.round(r1.plotW * DPR) && r1.img.height === Math.round(r1.plotH * DPR),
  `${r1.img.width}×${r1.img.height} vs ${Math.round(r1.plotW * DPR)}×${Math.round(r1.plotH * DPR)}`);
check('drawImage roztahuje obraz na plnou plochu v CSS px',
  r1.dw === r1.plotW && r1.dh === r1.plotH, `cíl ${r1.dw}×${r1.dh} vs ${r1.plotW}×${r1.plotH}`);
check('obraz se vkládá na (padL, padT), ne do rohu', r1.x === PADL && r1.y === PADT, `(${r1.x}, ${r1.y})`);
check('obraz nekončí v rohu — začíná až za osou Y',
  (r1.x + r1.dw) >= r1.plotW + PADL - 2, `pravý okraj ${r1.x + r1.dw} vs ${PADL + r1.plotW}`);

console.log('\n═══ Spektrogram: dynamika obrazu ═══\n');

check('obraz není celý tmavý (něco je vidět)', r1.maxR > 120, `max R = ${r1.maxR}`);
check('obraz není celý sytý (nesplývá)', r1.satPct < 8, `${r1.satPct.toFixed(1)} % saturovaných`);
check('šumové dno zůstává tmavé', r1.blankPct > 0.5, `${r1.blankPct.toFixed(1)} % prázdných`);

// Tatáž nahrávka 30 dB slabší musí vypadat stejně — dřív z toho byla jednolitá šeď.
const quiet = concat([voice(0.5, SR, 196, 0.010), voice(0.5, SR, 247, 0.010), voice(0.5, SR, 294, 0.010)], 0.25, SR);
const r2 = render(quiet);
check('potichu nahraný materiál dá stejný obraz jako nahlas',
  Math.abs(r2.maxR - r1.maxR) <= 3 && Math.abs(r2.satPct - r1.satPct) < 2,
  `maxR ${r1.maxR} vs ${r2.maxR}, sat ${r1.satPct.toFixed(1)} % vs ${r2.satPct.toFixed(1)} %`);
check('tichá nahrávka není celá tmavá', r2.maxR > 120, `max R = ${r2.maxR}`);

// Úzké plátno (telefon na výšku) nesmí spadnout ani vyrobit prázdný buffer.
const r3 = render(mel, 320);
check('úzké plátno (320 px) se vykreslí', r3.img.width > 400 && r3.maxR > 120,
  `${r3.img.width}×${r3.img.height}, max R = ${r3.maxR}`);

// Prásk do mikrofonu (jeden vzorek naplno) nesmí utopit celý spektrogram —
// proto se normalizuje podle 99,5. percentilu, ne podle maxima.
const bang = Float64Array.from(mel);
for (let i = 0; i < 40; i++) bang[Math.floor(bang.length / 2) + i] = 0.99;
const r4 = render(bang);
check('prásk do mikrofonu neztmaví celý spektrogram', r4.maxR > 120 && r4.satPct < 12,
  `max R = ${r4.maxR}, saturováno ${r4.satPct.toFixed(1)} %`);

// Extrémní okraje úrovně — obraz musí být vždy čitelný.
const whisper = voice(1.0, SR, 220, 0.0008);
const r5 = render(whisper);
check('velmi tichá nahrávka je pořád čitelná', r5.maxR > 120,
  `max R = ${r5.maxR} (úroveň 0,0008)`);

console.log(`\n${fail === 0 ? '✓' : '✗'} Spektrogram: ${pass} prošlo, ${fail} selhalo\n`);
process.exit(fail ? 1 : 0);
