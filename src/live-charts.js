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
 * Vykreslí historii SPR jako spojitou čáru.
 *
 * Referenční meze (nezpěvák −22,7 dB, profesionál −13,1 dB) se kreslí jako
 * vodorovné čárkované linky — ale NENÍ to verdikt „má/nemá ring". Je to jen
 * orientace, stejně jako v analýze nahrávky. Rozhoduje vyrovnanost mezi tóny,
 * kterou živý graf ukázat nemůže (na to je potřeba celá nahrávka).
 */
export function drawSprHistory(cv, { history = [], refs = null }) {
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);

  const padL = 34, padR = 8, padT = 10, padB = 14;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const yOf = (db) => padT + (1 - (db - SPR_MIN) / (SPR_MAX - SPR_MIN)) * plotH;

  // vodorovné linky po 10 dB
  ctx.font = '500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (let db = SPR_MIN; db <= SPR_MAX; db += 10) {
    const y = Math.round(yOf(db));
    ctx.fillStyle = COLORS.line;
    ctx.fillRect(padL, y, plotW, 1);
    ctx.fillStyle = COLORS.mute;
    ctx.fillText(String(db), padL - 4, y);
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

  // čára SPR
  if (history.length >= 2) {
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const n = history.length;
    for (let i = 0; i < n; i++) {
      const v = history[i];
      const x = padL + (n > 1 ? (i / (n - 1)) * plotW : 0);
      const y = yOf(Number.isFinite(v) ? Math.max(SPR_MIN, Math.min(SPR_MAX, v)) : SPR_MIN);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  } else {
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
