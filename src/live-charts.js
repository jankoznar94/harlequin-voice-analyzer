/**
 * Vykreslování živého indikátoru na plátno.
 *
 * Drží se stejná pravidla jako u ostatních grafů v aplikaci:
 *   - ploché tónování, žádný glow, žádné přechody
 *   - barvy se berou z CSS proměnných, aby indikátor neladil jinak než zbytek
 *   - žádné `putImageData` (ignoruje transformaci plátna a na displeji s
 *     devicePixelRatio > 1 sráží obsah do čtvrtiny — viz SKILL)
 *   - kreslí se jen změněné části: ručička ladění se hýbe 60×/s, spektrum
 *     jen když se opravdu změní hodnota
 */

/* ── barvy z CSS ──────────────────────────────────────────────────────────── */

/* Stupnice obrazu spektrogramu se bere z modulu, který počítá normalizaci
 * (live-spec.js). Kdyby se sem opsala čísla, rozejdou se — a obraz bude tmavý
 * nebo přesvětlený, aniž by si toho někdo všiml. */
import { SPEC_DB_LO, SPEC_DB_HI } from './live-spec.js';

function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v || '').trim() || fallback;
  } catch { return fallback; }
}

export const COLORS = {
  bg: '#1a1715', line: '#3a3330', fg: '#e8e2dc',
  dim: '#a89f97', mute: '#7d746d',
  accent: '#b8894f', ok: '#6a9e6a', bad: '#b5675e', warn: '#c39a5a',
};

export function loadColors() {
  COLORS.bg = cssVar('--bg', COLORS.bg);
  COLORS.line = cssVar('--line', COLORS.line);
  COLORS.fg = cssVar('--fg', COLORS.fg);
  COLORS.dim = cssVar('--fg-dim', COLORS.dim);
  COLORS.mute = cssVar('--fg-mute', COLORS.mute);
  COLORS.accent = cssVar('--accent', COLORS.accent);
  COLORS.ok = cssVar('--ok', COLORS.ok);
  COLORS.bad = cssVar('--bad', COLORS.bad);
  COLORS.warn = cssVar('--warn', COLORS.warn);
}

export const classColor = (cls) => ({
  ok: COLORS.ok, mid: COLORS.warn, bad: COLORS.bad, none: COLORS.mute,
}[cls] || COLORS.mute);

/* ── příprava plátna ──────────────────────────────────────────────────────── */

/**
 * Nastaví plátno na skutečnou hustotu displeje.
 *
 * `width`/`height` v HTML je jen návrh; bez tohohle je na telefonu s dpr 2
 * kresba měkká. Vrací rozměry v CSS pixelech, ve kterých se pak počítá.
 */
export function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || cv.width || 300;
  const h = cv.clientHeight || 300;
  const wpx = Math.round(w * dpr), hpx = Math.round(h * dpr);
  if (cv.width !== wpx || cv.height !== hpx) {
    cv.width = wpx;
    cv.height = hpx;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/* ── ručička ladění ───────────────────────────────────────────────────────── */

/** Rozsah, který ručička zobrazuje — 50 centů na každou stranu. */
export const CENTS_RANGE = 50;

/**
 * Vykreslí pruh ladění s ručičkou.
 *
 * Stupnice je záměrně lineární v centech, ne v Hz: 10 Hz u A2 je jiná
 * odchylka než 10 Hz u A5 a hudebně je důležitá právě odchylka v centech.
 */
export function drawTuning(cv, { cents = null, note = null, voiced = false, cls = 'none' }) {
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);

  const padX = 10;
  const plotW = w - padX * 2;
  const midY = h * 0.52;
  const barH = 10;
  const half = CENTS_RANGE;

  // základní pruh
  ctx.fillStyle = COLORS.line;
  ctx.fillRect(padX, midY - barH / 2, plotW, barH);

  // zóna „v tónu" (±15 centů) a „skoro" (±35) — vykreslené jako světlejší pruhy
  const zone = (c) => (c / half) * (plotW / 2);
  ctx.fillStyle = COLORS.bg;
  ctx.globalAlpha = 0.55;
  ctx.fillRect(padX + plotW / 2 - zone(35), midY - barH / 2, zone(35) * 2, barH);
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.line;
  ctx.fillRect(padX + plotW / 2 - zone(35), midY - barH / 2, zone(15.5) * 2, barH);
  void zone(15);

  // značky po 10 centech
  ctx.fillStyle = COLORS.mute;
  for (let c = -40; c <= 40; c += 10) {
    const x = padX + plotW / 2 + (c / half) * (plotW / 2);
    ctx.fillRect(Math.round(x), midY + barH / 2 + 2, 1, 4);
  }
  // střední značka
  ctx.fillStyle = COLORS.dim;
  ctx.fillRect(Math.round(padX + plotW / 2), midY - barH / 2 - 4, 1, barH + 8);

  // text: tón a odchylka
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = voiced && note ? COLORS.fg : COLORS.mute;
  ctx.fillText(voiced && note ? note : '—', w / 2, midY - barH / 2 - 10);

  ctx.font = '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = voiced && Number.isFinite(cents) ? classColor(cls) : COLORS.mute;
  if (voiced && Number.isFinite(cents)) {
    const sign = cents >= 0 ? '+' : '−';
    ctx.fillText(`${sign}${Math.abs(cents).toFixed(0)} centů`, w / 2, h - 6);
  } else {
    ctx.fillText('zpívej', w / 2, h - 6);
  }

  // ručička
  if (voiced && Number.isFinite(cents)) {
    const c = Math.max(-half, Math.min(half, cents));
    const x = padX + plotW / 2 + (c / half) * (plotW / 2);
    ctx.fillStyle = classColor(cls);
    ctx.fillRect(Math.round(x) - 1, midY - barH / 2 - 6, 3, barH + 12);
    // šipka nahoru pro hrubou orientaci, kterým směrem ladit
    ctx.beginPath();
    ctx.moveTo(Math.round(x), midY - barH / 2 - 11);
    ctx.lineTo(Math.round(x) - 5, midY - barH / 2 - 18);
    ctx.lineTo(Math.round(x) + 5, midY - barH / 2 - 18);
    ctx.closePath();
    ctx.fill();
  }
}

/* ── pruh úrovně ──────────────────────────────────────────────────────────── */

/** Rozsah, který pruh úrovně zobrazuje. */
export const LEVEL_MIN = -60;
export const LEVEL_MAX = 0;

export function drawLevel(cv, { dbfs = -Infinity, cls = 'none' }) {
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);

  const padX = 10, barH = 12;
  const plotW = w - padX * 2;
  const y = (h - barH) / 2;

  ctx.fillStyle = COLORS.line;
  ctx.fillRect(padX, y, plotW, barH);

  // komfortní pásmo −30…−6 dBFS
  const xOf = (db) => padX + ((Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, db)) - LEVEL_MIN) / (LEVEL_MAX - LEVEL_MIN)) * plotW;
  ctx.fillStyle = COLORS.bg;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(xOf(-30), y, xOf(-6) - xOf(-30), barH);
  ctx.globalAlpha = 1;

  if (Number.isFinite(dbfs)) {
    ctx.fillStyle = classColor(cls);
    ctx.fillRect(padX, y, xOf(dbfs) - padX, barH);
    ctx.fillStyle = COLORS.fg;
    ctx.fillRect(Math.round(xOf(dbfs)) - 1, y - 2, 2, barH + 4);
  }

  ctx.font = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = COLORS.mute;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('−60', padX, y + barH + 3);
  ctx.textAlign = 'right';
  ctx.fillText('0 dBFS', padX + plotW, y + barH + 3);
}

/* ── vývoj SPR v čase ─────────────────────────────────────────────────────── */

/** Rozsah SPR, který graf ukazuje. */
export const SPR_MIN = -40;
export const SPR_MAX = 0;

/**
 * Pásmo, ve kterém se pohybuje většina zpěvů, a jeho podíl na výšce grafu.
 *
 * Lineární rozsah −40…0 dB dělá z pásma −20…−10 dB čtvrtinu výšky (10 dB ze 40)
 * a po odečtení okrajů z toho byla tenká čára — nebylo poznat, kde přesně se
 * zpěvák nachází, což je přesně to, co má živý indikátor ukázat. Proto je
 * měřítko osy NELINEÁRNÍ: v pásmu zabírá 1 dB ~4,4× víc místa než mimo něj.
 *
 * Podíly jsou tři, ne dva: kdyby horní dekáda (−10…0) dostala jen zbytek po
 * pásmu, zbylo by na ni ~10 px a popisky „−10“ a „0“ by se překryly. Proto má
 * každá část svůj pevný podíl a pásmo zůstává největší.
 */
export const SPR_BAND = [-20, -10];
export const SPR_SHARE_ABOVE = 0.20;   // −10…0 dB
export const SPR_SHARE_BAND = 0.55;   // −20…−10 dB
export const SPR_SHARE_BELOW = 0.25;  // −40…−20 dB

/**
 * Převod SPR (dB) na svislou polohu v grafu: 0 = horní okraj, 1 = dolní okraj.
 *
 * Zlom měřítka je jen na hranicích pásma (v −20 a −10 dB), mezi nimi je osa
 * zase rovná — žádné plynulé „rybí oko“, to by se v číslech hůř hledalo.
 * Hodnoty mimo rozsah se přiříznou na okraj, nevynechají.
 */
export function sprOffset(db) {
  const v = Math.max(SPR_MIN, Math.min(SPR_MAX, Number.isFinite(db) ? db : SPR_MIN));
  const [lo, hi] = SPR_BAND;
  const aboveSpan = SPR_MAX - hi;      // −10…0
  const bandSpan = hi - lo;            // −20…−10
  const belowSpan = lo - SPR_MIN;      // −40…−20
  if (v >= hi) return SPR_SHARE_ABOVE * (SPR_MAX - v) / (aboveSpan || 1);
  if (v <= lo) return SPR_SHARE_ABOVE + SPR_SHARE_BAND + SPR_SHARE_BELOW * (lo - v) / (belowSpan || 1);
  return SPR_SHARE_ABOVE + SPR_SHARE_BAND * (hi - v) / (bandSpan || 1);
}

/**
 * Vodorovné linky osy i s popisky.
 *
 * Uvnitř roztaženého pásma je navíc linka na −15 dB — pásmo je vysoké, takže
 * čtení hodnoty usnadní. Linka na −5 dB by naopak splynula s „−10“ i „0“,
 * proto se vynechává: roztažení pásma nutně zhušťuje zbytek osy.
 */
export function sprTicks() {
  const t = [];
  for (let db = SPR_MIN; db <= SPR_MAX; db += 10) t.push({ db, strong: true });
  const mid = (SPR_BAND[0] + SPR_BAND[1]) / 2;
  if (SPR_SHARE_BAND > 0 && mid > SPR_MIN && mid < SPR_MAX) t.push({ db: mid, strong: false });
  return t;
}

/**
 * Vykreslí historii SPR jako dvě čáry.
 *
 * Dvě čáry, stejná logika jako v reportu z nahrávky:
 *   ACCENT (plná)  — PŘESNÉ číslo: SPR po rámcích okna 4096, horní percentil.
 *                    To je totéž měřidlo jako `spr_novy` v analýze nahrávky,
 *                    takže se dá číslo z indikátoru porovnat s reportem.
 *   DIM (tenká)    — SPR z jednoho okna 2048. Záměrně zobrazená, i když je o
 *                    pár dB níž: ukazuje, že starší měřidlo sráží vibrato, a
 *                    je to číslo, na které je zvyklý kdekoli jinde v aplikaci.
 *
 * Referenční meze (nezpěvák −22,7 dB, profesionál −13,1 dB) se kreslí jako
 * vodorovné čárkované linky — ale NENÍ to verdikt „má/nemá ring". Je to jen
 * orientace, stejně jako v analýze nahrávky. Rozhoduje vyrovnanost mezi tóny,
 * kterou živý graf ukázat nemůže (na to je potřeba celá nahrávka).
 *
 * POZOR na jednu věc, která se u dvou čísel plete: srovnávat s literaturou
 * (Omori) se smí JEN to starší — Omoriho čísla vznikla měřením, které vibrato
 * rozmazává stejně. Proto jsou referenční linky vztažené ke staré čáře a
 * přesná čára se kreslí jako druhá, ne místo ní.
 */
export function drawSprHistory(cv, { history = [], historyOld = null, refs = null }) {
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);

  const padL = 34, padR = 8, padT = 10, padB = 14;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const yOf = (db) => padT + sprOffset(db) * plotH;

  // Roztažené pásmo se mírně podbarví — bez toho není na první pohled vidět,
  // že se měřítko v prostředku mění a že stejná vzdálenost na ose tam znamená
  // jiný počet dB.
  if (SPR_SHARE_BAND > 0) {
    const yB = yOf(SPR_BAND[0]), yT = yOf(SPR_BAND[1]);
    ctx.fillStyle = COLORS.bg;
    ctx.globalAlpha = 0.3;
    ctx.fillRect(padL, Math.min(yB, yT), plotW, Math.abs(yB - yT));
    ctx.globalAlpha = 1;
  }

  // vodorovné linky po 10 dB (+ po 5 dB uvnitř roztaženého pásma)
  ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const { db, strong } of sprTicks()) {
    const y = Math.round(yOf(db));
    ctx.fillStyle = COLORS.line;
    ctx.fillRect(padL, y, plotW, 1);
    ctx.fillStyle = COLORS.mute;
    ctx.globalAlpha = strong ? 1 : 0.75;
    ctx.fillText(String(db), padL - 4, y);
    ctx.globalAlpha = 1;
  }

  // referenční meze
  if (refs) {
    ctx.setLineDash([3, 3]);
    for (const [db, col] of refs) {
      if (db < SPR_MIN || db > SPR_MAX) continue;
      const y = Math.round(yOf(db));
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(padL, y + 0.5);
      ctx.lineTo(padL + plotW, y + 0.5);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // čáry SPR — nejdřív STARŠÍ (tlustá, bledá), pak PŘESNÁ (tenká, akcent)
  const lineOf = (vals, color, width, alpha) => {
    if (!vals || vals.length < 2) return false;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const n = vals.length;
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      const x = padL + (n > 1 ? (i / (n - 1)) * plotW : 0);
      const y = yOf(Number.isFinite(v) ? Math.max(SPR_MIN, Math.min(SPR_MAX, v)) : SPR_MIN);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    return true;
  };

  let drew = false;
  if (historyOld && historyOld.length >= 2) {
    drew = lineOf(historyOld, COLORS.accent, 2.5, 0.35) || drew;
  }
  drew = lineOf(history, COLORS.accent, 1.5, 1) || drew;

  if (!drew) {
    ctx.fillStyle = COLORS.mute;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('sbírá se…', padL + plotW / 2, padT + plotH / 2);
  }

  // popis osy
  ctx.fillStyle = COLORS.mute;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('SPR (dB) · posledních ~20 s', padL, padT + plotH + 12);

  // popisek roztaženého pásma — jinak by nebylo poznat, že se měřítko mění
  if (SPR_SHARE_BAND > 0) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.75;
    ctx.fillText('pásmo zpěvu', padL + plotW - 2, (yOf(SPR_BAND[0]) + yOf(SPR_BAND[1])) / 2);
    ctx.globalAlpha = 1;
  }
}

/* ── sloupcový ukazatel formantového prostoru (orientační) ────────────────── */

/**
 * Vykreslí polohu FHE (barva hlasu) proti pásmu očekávanému pro zvolený obor.
 *
 * FHE je frekvence, pod kterou leží polovina energie v pásmu 2–3,6 kHz.
 * Vyšší = světlejší hlas. Pásmo je ±1 směrodatná odchylka z literatury,
 * takže slouží k orientaci, ne k soudu o hlasu.
 */
export function drawFhe(cv, { fheHz = NaN, ref = null, band = 'none' }) {
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);

  const padL = 10, padR = 10;
  const plotW = w - padL - padR;
  const barH = 8;
  const y = h * 0.5 - barH / 2;

  // rozsah osy: 2000–3600 Hz pokrývá všechny obory
  const lo = 2000, hi = 3600;
  const xOf = (f) => padL + ((Math.max(lo, Math.min(hi, f)) - lo) / (hi - lo)) * plotW;

  ctx.fillStyle = COLORS.line;
  ctx.fillRect(padL, y, plotW, barH);

  if (ref) {
    ctx.fillStyle = COLORS.bg;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(xOf(ref[0] - ref[1]), y, xOf(ref[0] + ref[1]) - xOf(ref[0] - ref[1]), barH);
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS.dim;
    ctx.fillRect(Math.round(xOf(ref[0])), y - 3, 1, barH + 6);
  }

  if (Number.isFinite(fheHz)) {
    const col = { ok: COLORS.ok, nizka: COLORS.accent, vysoka: COLORS.accent }[band] || COLORS.mute;
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(xOf(fheHz)) - 1, y - 5, 3, barH + 10);
  }

  ctx.font = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.mute;
  ctx.fillText('2 kHz', padL, y + barH + 4);
  ctx.textAlign = 'right';
  ctx.fillText('3,6 kHz', padL + plotW, y + barH + 4);
  if (Number.isFinite(fheHz)) {
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.fg;
    ctx.fillText(`${Math.round(fheHz)} Hz`, xOf(fheHz), y - 20);
  }
}

/* ── živý spektrogram ────────────────────────────────────────────────────── */

/**
 * Rozměry živého spektrogramu — STEJNÉ jako spektrogram z nahrávky (SPEC_H
 * a SPEC_PAD v charts.js). Panel se při přepínání záložek nesmí hýbat a obraz
 * musí vypadat stejně; hlídá to `test/test-live-spektrogram-render.mjs`.
 */
export const LIVE_SPEC_H = 230;
export const LIVE_SPEC_PAD = { l: 42, r: 12, t: 12, b: 26 };

/** Kolik sloupců se drží (při 20 ms na sloupec je to ~10 s). */
export const LIVE_SPEC_COLS = 500;

/**
 * Barevná stupnice — OPSANÁ z drawSpec v charts.js, nesmí se rozejít.
 *
 * Je to teplý neutrál → jantar → bílá. Stupnice byla odladěná měřením (viz
 * komentář v charts.js): svítivost roste pomalu, barva se láme až nad 85 %,
 * takže šumové dno zůstane tmavé a formanty nad ním vylezou. Když se změní
 * tam, musí se změnit i tady.
 */
const SPEC_RAMP_R = (t) => (t < 0.55 ? 22 + t * 110 : 22 + 60.5 + (t - 0.55) * 300);
const SPEC_RAMP_G = (t) => (t < 0.55 ? 18 + t * 90 : 18 + 49.5 + (t - 0.55) * 240);
const SPEC_RAMP_B = (t) => (t < 0.55 ? 16 + t * 42 : 16 + 23.1 + (t - 0.55) * 150);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Barva pozadí obrazu — stejná jako dno stupnice, ať se okraje nelesknou. */
const SPEC_BG = (255 << 24) | (clamp255(SPEC_RAMP_B(0)) << 16) | (clamp255(SPEC_RAMP_G(0)) << 8) | clamp255(SPEC_RAMP_R(0));

/**
 * Předpočítaná tabulka barev (256 kroků) — v jednom 32bitovém čísle.
 *
 * PROČ: původní cesta (čtyři bajty na pixel) naměřila 1,21 ms na obraz
 * 500×192 při dpr 2; zápis jednoho 32bitového slova 0,57 ms. Původní cestu
 * zvolit nejde i proto, že `putImageData` ignoruje transformaci plátna
 * (viz SKILL) — buffer se proto plní v device px a na plátno jde přes
 * `drawImage`.
 */
const SPEC_LUT = (() => {
  const lut = new Uint32Array(256);
  for (let k = 0; k < 256; k++) {
    const t = k / 255;
    lut[k] = (255 << 24) | (clamp255(SPEC_RAMP_B(t)) << 16) | (clamp255(SPEC_RAMP_G(t)) << 8) | clamp255(SPEC_RAMP_R(t));
  }
  return lut;
})();

/**
 * Připraví stav kresby živého spektrogramu.
 *
 * `values` drží NORMALIZOVANÉ hodnoty (0 = dno stupnice, 1 = vrchol), ne
 * surová dB. Důvod je praktický: normalizace se v čase mění (roste percentil),
 * takže by se při změně měřítka musel překreslovat celý obraz z historie —
 * a ta by se musela celá držet. S normalizovanými hodnotami je změna měřítka
 * jen o tom, co se do buferu zapíše nově.
 *
 * POZOR Plátno se předává UŽ TADY, ne až při kreslení. Naměřeno: když si buffer
 * vytvářela až kresba, stav se při prvním vykreslení resetoval — a sloupce,
 * které do něj přišly předtím, zmizely (obraz zůstal prázdný, `filled` bylo 0).
 *
 * @param rows počet řádků obrazu (musí odpovídat výšce plátna)
 * @param cv   plátno, na které se bude kreslit
 */
export function createSpecPainter(rows = 192, cv = null) {
  return {
    rows,
    cv,
    cols: LIVE_SPEC_COLS,
    values: new Float32Array(LIVE_SPEC_COLS * rows),   // 0 = dno, 1 = vrchol
    filled: 0,          // kolik sloupců už je vyplněno (do zaplnění okna)
    head: 0,            // kam přijde další sloupec v kruhovém zásobníku
    total: 0,           // kolik sloupců přišlo celkem
    img: null, devW: 0, devH: 0, dpr: 0,
    plotWpx: 0, posOf: null,     // rozvržení sloupců — počítá se při kresbě
    off: null,          // pomocné plátno s hotovým obrazem
    offCtx: null,
    lastDrawnTotal: 0,
    lastDrawnFull: false,
    repaintAll: true,
  };
}

/**
 * Připraví buffer a rozvržení sloupců pro aktuální hustotu displeje.
 *
 * Volá se z vkládání sloupce i z kresby, takže je buffer hotový dřív, než
 * přijde první sloupec. Při ZMĚNĚ VELIKOSTI se přepočítá rozvržení a nastaví
 * se `repaintAll` — historie sloupců zůstává, jen se celá překreslí.
 *
 * POZOR Stav (`filled`, `head`, `total`) se při tom NESMÍ nulovat: sloupce, které
 * už přišly, jsou platná historie. Naměřeno, že nulování uvnitř kresby vedlo
 * k prázdnému obrazu.
 */
function ensureBuffer(st) {
  const cv = st.cv;
  if (!cv) return false;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || cv.width || 300;
  const h = cv.clientHeight || LIVE_SPEC_H;
  /* POZOR Buffer je jen KRESLICÍ PLOCHA, ne celé plátno.
   *
   * Naměřeno: když se buffer udělal na šířku celého plátna (700 px) a na plátno
   * se pak vložil s šířkou kreslicí plochy (646 px), prohlížeč ho ZMENŠIL
   * v poměru 646/700 a celý obraz se posunul doleva (o ~47 px, tedy o 7 %
   * šířky) — jasný blok, který měl končit na pravém okraji, skončil 36 sloupců
   * před ním. Proto se okraje do bufferu vůbec nedávají: buffer = plocha,
   * vkládá se 1 : 1. */
  const devW = Math.round((w - LIVE_SPEC_PAD.l - LIVE_SPEC_PAD.r) * dpr);
  const devH = Math.round((h - LIVE_SPEC_PAD.t - LIVE_SPEC_PAD.b) * dpr);
  st.canvasW = Math.round(w * dpr);
  st.canvasH = Math.round(h * dpr);
  if (st.devW !== devW || st.devH !== devH || !st.img) {
    st.devW = devW; st.devH = devH; st.dpr = dpr;
    st.img = new Uint32Array(devW * devH);
    st.img.fill(SPEC_BG);
    st.off = document.createElement('canvas');
    st.off.width = devW; st.off.height = devH;
    st.offCtx = st.off.getContext('2d');
    st.lastDrawnFull = false;
    st.repaintAll = true;
  }
  /* Rozvržení sloupců na pixel přesně (Bresenham).
   *
   * POZOR Stejná celočíselná šířka sloupce NEFUNGUJE: `plotWpx` skoro nikdy není
   * dělitelné počtem sloupců (naměřeno: 646 px na 500 sloupců → šířka 1 px,
   * takže 146 px = 23 % šířky zůstalo prázdných jako pozadí vlevo). Šířky se
   * proto střídají o jeden pixel a dohromady dají PŘESNĚ `plotWpx`.
   *
   * Pozice se počítají z ABSOLUTNÍHO indexu sloupce (`round(k·P/C)`), ne
   * sčítáním šířek — jinak by se zaokrouhlovací chyba nasčítala a obraz by se
   * vůči sobě rozjel. */
  st.posOf = (k) => Math.round(k * devW / st.cols);
  return true;
}

/**
 * Zaznamená nový sloupec obrazu.
 *
 * @param st     stav z createSpecPainter
 * @param column surové hodnoty z `specColumn` (jednotky reportu)
 * @param norm   normalizace, kterou se má sloupec přepočítat (z `feedSpec`)
 */
export function pushSpecColumn(st, column, norm) {
  ensureBuffer(st);
  /* POZOR KRUHOVÝ ZÁSOBNÍK: `head` ukazuje na NEJSTARŠÍ žijící sloupec, ne na
   * první volný. Když je okno plné, přepisuje se právě ten nejstarší — jinak
   * by nový sloupec přepsal některý z těch, které mají zůstat vidět.
   * Naměřeno: když se psalo vždy na `head` a `head` se posunoval dál, obraz
   * zůstal uprostřed plný a nejnovější sloupce se ztratily (blok, který měl
   * sahat k pravému okraji, skončil o ~40 sloupců vlevo). */
  const writePos = st.filled < st.cols ? st.filled : st.head;
  const base = writePos * st.rows;
  const span = SPEC_DB_HI - SPEC_DB_LO;
  for (let r = 0; r < st.rows; r++) {
    const t = (column[r] - norm - SPEC_DB_LO) / span;
    st.values[base + r] = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  /* Nový sloupec jde VŽDY na konec obrazu — v kruhovém zásobníku je to
   * právě ten, který se přepsal, takže se `head` posune dál. */
  st.head = (writePos + 1) % st.cols;
  if (st.filled < st.cols) st.filled++;
  st.total++;
}

/** Pořadí sloupců v obraze od nejstaršího: `i` = 0 je nejstarší, `filled−1` nejnovější. */
function colIndex(st, i) {
  const first = st.filled < st.cols ? 0 : st.head;
  return (first + i) % st.cols;
}

/**
 * Vykreslí živý spektrogram.
 *
 * Obraz roste zprava doleva (nejnovější vpravo), stejně jako u nahrávky.
 * Když se okno posune o jeden sloupec, překresluje se JEN ten nejnovější —
 * obraz se posune v bufferu (`copyWithin`) a na plátno se dostane jedním
 * `drawImage`. Plná kresba se dělá jen na začátku a po změně měřítka displeje.
 *
 * @param warm true, dokud se měřítko ustaluje (kresba to přizná popiskem)
 */
export function drawLiveSpec(cv, st, { warm = false } = {}) {
  if (!st.cv) st.cv = cv;
  if (!ensureBuffer(st)) return;
  const devW = st.devW, devH = st.devH, dpr = st.dpr;
  /* POZOR — ROZMĚR PLÁTNA SE NASTAVUJE JEN KDYŽ SE OPRAVDU ZMĚNÍ.
   *
   * Reálná vada, kterou uživatel viděl jako „nepříjemné poblikávání části,
   * která ještě nemá data": nastavení `canvas.width` podle specifikace
   * VYMAŽE celý bitmap plátna, i když je hodnota stejná. Tady se rozměr
   * nastavoval bezpodmínečně při KAŽDÉM rámci, tedy 50× za sekundu —
   * naměřeno `tools/diag-live-spec-flicker.mjs`: spektrogram 50/s, kdežto
   * ostatní živé grafy (`fitCanvas`) 0/s. Ty nastavují rozměr jen při změně,
   * a proto neblikají.
   *
   * Po skutečné změně rozměru je bitmap prázdný, takže se musí překreslit
   * CELÝ obraz (`repaintAll`) — jinak by zůstal prázdný.
   */
  if (cv.width !== st.canvasW || cv.height !== st.canvasH) {
    cv.width = st.canvasW;
    cv.height = st.canvasH;
    st.repaintAll = true;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = cv.clientWidth || cv.width || 300;
  const h = cv.clientHeight || LIVE_SPEC_H;

  const padL = LIVE_SPEC_PAD.l, padR = LIVE_SPEC_PAD.r, padT = LIVE_SPEC_PAD.t, padB = LIVE_SPEC_PAD.b;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const plotWpx = devW;              // buffer JE kreslicí plocha (viz ensureBuffer)
  const plotHpx = devH;
  const posOf = st.posOf;

  /**
   * Zapíše sloupec do bufferu; `x0` je levá hrana, `x1` pravá (v device px).
   *
   * Šířka se bere z posic dvou sousedních sloupců — tím je zaručeno, že
   * dohromady dají přesně šířku obrazu a nikde nezůstane prázdný pruh.
   */
  const writeColumn = (idx, x0, x1) => {
    const base = idx * st.rows;
    for (let r = 0; r < st.rows; r++) {
      const v = SPEC_LUT[(st.values[base + r] * 255) | 0];
      // řádek 0 = horní (nejvyšší kmitočet) — stejná orientace jako u nahrávky
      const y0 = Math.round(r * plotHpx / st.rows), y1 = Math.round((r + 1) * plotHpx / st.rows);
      for (let y = y0; y < y1; y++) {
        const rowOff = y * devW;
        for (let x = x0; x < x1; x++) st.img[rowOff + x] = v;
      }
    }
  };

  const full = st.filled === st.cols;
  const shift = st.total - st.lastDrawnTotal;
  if (!st.repaintAll && st.lastDrawnFull && full && shift === 1) {
    /* Posun okna: zahoď nejstarší sloupec vlevo, nakresli nejnovější vpravo.
     *
     * POZOR Posun se dělá o šířku PRÁVĚ ZAHOZENÉHO (levého) sloupce, ne o tu na
     * konci: při rozvržení Bresenhamem mají různé sloupce šířku o pixel jinou
     * (naměřeno: 1 nebo 2 px při 646 px na 500 sloupců). Když se vezme špatná,
     * obraz se časem rozjede — naměřeno jako postupné uhýbání doprava. */
    const drop = posOf(1) - posOf(0);
    const copyPx = plotWpx - drop;
    for (let y = 0; y < plotHpx; y++) {
      const rowOff = y * devW;
      st.img.copyWithin(rowOff, rowOff + drop, rowOff + drop + copyPx);
    }
    /* Nový sloupec je v kruhovém zásobníku ten, který se právě přepsal, tedy
     * `head − 1`. Jeho šířka se bere z TÉŽE absolutní pozice jako při plné
     * kresbě (`posOf(cols−1)`), jinak by se zaokrouhlení rozešlo s rozvržením. */
    const k = st.cols - 1;
    writeColumn((st.head - 1 + st.cols) % st.cols, posOf(k), plotWpx);
  } else {
    /* Plná kresba: nejstarší sloupec vlevo, nejnovější vpravo.
     *
     * POZOR — NEJNOVĚJŠÍ SLOUPEC SE NESMÍ ROZTAHNOUT PŘES ZBYTEK GRAFU.
     *
     * Bylo to tu `i === st.filled - 1 ? plotWpx : posOf(i + 1)` a dělalo to
     * reálnou vadu, kterou uživatel popsal jako „část, která ještě nebyla
     * vyplněna daty, nepříjemně poblikává". Dokud okno není plné, žije
     * v obraze jen `filled` sloupců — ten poslední se ale kvůli téhle úpravě
     * roztáhl až k PRAVÉMU OKRAJI. Každý rámec se jeho obsah přepsal novou
     * barvou, takže velká plocha měnila odstín 50× za sekundu. Na začátku
     * měření je neplná skoro celá plocha, takže blikal téměř celý graf
     * (naměřeno: podíl sloupců s daty 100 % hned v první sekundě, přitom
     * okno je ~10 s).
     *
     * Správně má každý sloupec STEJNOU ŠÍŘKU jako hotový obraz: od `posOf(i)`
     * do `posOf(i + 1)`. Pro poslední vyplněný sloupec to je `posOf(filled)`,
     * což je zároveň `plotWpx` ve chvíli, kdy je okno plné (`posOf(cols)` =
     * `round(cols·devW/cols)` = `devW`) — obě větve se tedy v tom bodě
     * přesně sejdou a obraz při přechodu neusk očí.
     *
     * Výsledek: data dorůstají ZLEVA a zbytek vpravo zůstává prázdné pozadí. */
    for (let i = 0; i < st.filled; i++) {
      const idx = colIndex(st, i);
      writeColumn(idx, posOf(i), posOf(i + 1));
    }
    st.repaintAll = false;
  }
  st.lastDrawnTotal = st.total;
  st.lastDrawnFull = full;

  // buffer → pomocné plátno → plátno (jediné překreslení, se transformací)
  const data = new ImageData(new Uint8ClampedArray(st.img.buffer), devW, devH);
  if (st.off.width !== devW || st.off.height !== devH) { st.off.width = devW; st.off.height = devH; }
  st.offCtx.putImageData(data, 0, 0);
  ctx.drawImage(st.off, padL, padT, plotWpx / dpr, plotH);

  // mřížka a popisky — stejné kmitočty jako u nahrávky
  const yFor = (hz) => padT + plotH - (hz / 6000) * plotH;
  ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = COLORS.mute;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const hz of [0, 1000, 2000, 3000, 4000, 5000, 6000]) {
    ctx.fillText(hz >= 1000 ? `${hz / 1000} kHz` : '0', padL - 4, yFor(hz));
  }
  ctx.textAlign = 'left';
  ctx.fillText('Hz', 4, padT);

  // pásmo zpěváckého formantu — stejné jako u nahrávky (čárkované)
  ctx.strokeStyle = 'rgba(120,190,190,.45)';
  ctx.setLineDash([4, 3]);
  for (const hz of [2500, 3200]) {
    const yy = Math.round(yFor(hz)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
  }
  ctx.setLineDash([]);

  // popisek doby — okno drží ~10 s
  ctx.fillStyle = COLORS.mute;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'right';
  ctx.fillText('posledních ~10 s', padL + plotW, padT + plotH + 14);

  /* Dokud se obraz nezahřeje, je normalizace pevná a hodnota se může rozejít
   * s tím, co uvidí report. Přiznat to — stejná zásada jako u ostatních hlášek:
   * neslibovat přesnost, kterou metrika v tu chvíli nemá. */
  if (warm) {
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.warn;
    ctx.fillText('měřítko se ustaluje', padL + 4, padT + 12);
  }

  if (!st.filled) {
    ctx.fillStyle = COLORS.mute;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText('sbírá se…', padL + plotW / 2, padT + plotH / 2);
  }
}
