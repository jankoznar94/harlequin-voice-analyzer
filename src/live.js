/**
 * Živá zpětná vazba — čistá logika bez prohlížeče.
 *
 * Záměrně BEZ DOM, bez AudioContextu: celé jádro se dá prohnat v Node, takže
 * se dá testovat i tam, kde mikrofon není (což je přesně tento stroj).
 * Vykreslování je oddělené v live-ui.js.
 *
 * Co se měří a proč:
 *   výška  — okamžitá f0 a odchylka v centech od nejbližšího tónu
 *   úroveň — RMS v dBFS, aby bylo vidět, že se zpívá málo/moc
 *   SPR    — z KLUZAVÉHO spektra, ne z jednoho rámce. Jeden 42ms rámec je pro
 *            SPR příliš krátký a hodnota skáče o desítky dB podle fáze; proto
 *            se drží exponenciální průměr spektra (~0,2 s).
 *
 * POZOR na jednu věc, která se u SPR plete: absolutní mez −20 dB NENÍ verdikt.
 * Živý indikátor proto hlásí hodnotu a referenční pásma, ale sám z ní nedělá
 * „má/nemá ring" — to umí až analýza nahrávky, která tóny segmentuje a porovnává
 * je mezi sebou (viz SKILL, „vyrovnanost ≠ úroveň").
 */

import { hzToNote, spr, fhe, REFS } from './analysis.js';

/* ── konstanty ────────────────────────────────────────────────────────────── */

/** Délka rámce pro živou analýzu. 2048 @48 kHz = 42,7 ms — dost na 70 Hz. */
export const FRAME_SIZE = 2048;

/** Jak chodí bloky z AudioWorkletu (ms). */
export const BLOCK_MS = 20;

/** Pod touto úrovní se rámec považuje za ticho a do spektra se nepřičte. */
export const RMS_GATE = 0.010;

/** Časová konstanta vyhlazení spektra v rámcích (α = 1/K). */
export const SPEC_ALPHA = 0.12;

/** Ladění: do kolika centů se to ještě považuje za „v tónu". */
export const CENTS_OK = 15;
export const CENTS_MID = 35;

/* ── pomocné převody ──────────────────────────────────────────────────────── */

/** Nejbližší tón rovnoměrné temperatury a odchylka v centech. */
export function centsFromNote(f0) {
  if (!(f0 > 0)) return { note: null, cents: null, targetHz: null };
  const midi = Math.round(12 * Math.log2(f0 / 440) + 69);
  const targetHz = 440 * Math.pow(2, (midi - 69) / 12);
  const cents = 1200 * Math.log2(f0 / targetHz);
  return { note: hzToNote(f0), cents, targetHz, midi };
}

export function rmsToDbfs(rms) {
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * SPR a FHE přímo z LINEÁRNÍHO výkonového spektra.
 *
 * Proč bez převodu na dB: SPR je jen rozdíl dvou vrcholů, takže
 * 10·log10(peakHi/peakLo) dá totéž číslo a ušetří 1024× log10 na každý rámec.
 */
export function metricsFromPower(acc, sampleRate, frameSize, nAcc = 1) {
  const half = acc.length;
  const binHz = sampleRate / frameSize;
  let hiPeak = 0, loPeak = 0;
  for (let i = 1; i < half; i++) {
    const f = i * binHz;
    const p = acc[i] / nAcc;
    if (f >= 2000 && f <= 4000) { if (p > hiPeak) hiPeak = p; }
    else if (f < 2000) { if (p > loPeak) loPeak = p; }
  }
  const sprDb = (hiPeak > 0 && loPeak > 0) ? 10 * Math.log10(hiPeak / loPeak) : NaN;

  // FHE — kde kumulativní energie v 2–3,6 kHz dosáhne 50 %
  let total = 0;
  const lo = Math.ceil(2000 / binHz), hi = Math.floor(3600 / binHz);
  for (let i = lo; i <= hi && i < half; i++) total += acc[i] / nAcc;
  let fheHz = NaN;
  if (total > 0) {
    let c = 0;
    for (let i = lo; i <= hi && i < half; i++) {
      c += acc[i] / nAcc;
      if (c >= 0.5 * total) { fheHz = i * binHz; break; }
    }
  }
  return { spr: sprDb, fhe: fheHz };
}

/** Zařazení SPR do referenčních pásem. NENÍ verdikt o ringu — jen orientace. */
export function sprBand(sprDb) {
  if (!Number.isFinite(sprDb)) return 'none';
  const profi = REFS.SPR.profesional[0];   // −13,1
  const nezpevak = REFS.SPR.nezpevak[0];   // −22,7
  if (sprDb >= profi) return 'profi';
  if (sprDb >= nezpevak) return 'mezi';
  return 'pod';
}

/** FHE v pásmu očekávaném pro daný obor (jen orientace, ±1 směrodatná odchylka). */
export function fheBand(fheHz, fach) {
  const ref = REFS.FHE[fach];
  if (!REFS.FHE[fach] || !Number.isFinite(fheHz)) return 'none';
  const d = fheHz - ref[0];
  if (Math.abs(d) <= ref[1]) return 'ok';
  return d < 0 ? 'nizka' : 'vysoka';
}

/* ── stav živého měření ───────────────────────────────────────────────────── */

export function createLiveState(sampleRate = 48000, frameSize = FRAME_SIZE) {
  return {
    sampleRate,
    frameSize,
    frames: 0,            // všech rámců
    voicedFrames: 0,      // rámců nad prahem (skutečně zpívaných)
    lastF0: 0,
    lastDbfs: -Infinity,
    lastCents: null,
    lastNote: null,
    sprSamples: [],       // historie SPR pro průběžný medián
    fheSamples: [],
    centsHist: [],        // pro rozptyl ladění
    peakDbfs: -Infinity,
    startedAt: null,
  };
}

/**
 * Zpracuje jeden živý rámec.
 *
 * @param state  stav z createLiveState
 * @param dsp    backend (wasm-dsp.js) — bere vzorky a vrací f0 + spektrum
 * @param frame  vzorky rámce (Float32/Float64)
 * @returns snapshot pro UI
 */
export function feedFrame(state, dsp, frame) {
  const sr = state.sampleRate;
  const n = Math.min(frame.length, state.frameSize);

  // 1. výška + spektrum jedním průchodem (WASM)
  const f0raw = dsp.process(frame.subarray(0, n));
  const rms = dsp.rms(frame.subarray(0, n));
  const dbfs = rmsToDbfs(rms);

  state.frames++;
  if (state.startedAt === null) state.startedAt = Date.now();
  if (dbfs > state.peakDbfs) state.peakDbfs = dbfs;

  const voiced = rms >= RMS_GATE && f0raw > 0;

  let metrics = { spr: NaN, fhe: NaN };
  if (voiced) {
    state.voicedFrames++;
    // spektrum se do klouzavého průměru přičte jen když se skutečně zpívá —
    // jinak by ticho hodnotu SPR ředilo a indikátor by lhal směrem dolů
    dsp.accumulate();
    metrics = dsp.readMetrics();
    if (Number.isFinite(metrics.spr)) state.sprSamples.push(metrics.spr);
    if (Number.isFinite(metrics.fhe)) state.fheSamples.push(metrics.fhe);
  }

  let pitch = { note: null, cents: null, targetHz: null };
  if (voiced) {
    pitch = centsFromNote(f0raw);
    state.lastCents = pitch.cents;
    state.lastNote = pitch.note;
    state.centsHist.push(pitch.cents);
  }

  state.lastF0 = voiced ? f0raw : 0;
  state.lastDbfs = dbfs;

  return {
    f0: voiced ? f0raw : 0,
    note: pitch.note,
    cents: pitch.cents,
    targetHz: pitch.targetHz,
    dbfs,
    voiced,
    spr: metrics.spr,
    sprBand: sprBand(metrics.spr),
    fhe: metrics.fhe,
    sprMedian: median(state.sprSamples),
    voicedFrames: state.voicedFrames,
    frames: state.frames,
  };
}

export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length & 1 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Souhrn po skončení živého měření. */
export function summarizeLive(state) {
  const secs = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
  const sprMed = median(state.sprSamples);
  return {
    seconds: secs,
    frames: state.frames,
    voicedFrames: state.voicedFrames,
    voicedPct: state.frames ? Math.round(100 * state.voicedFrames / state.frames) : 0,
    peakDbfs: state.peakDbfs,
    sprMedian: sprMed,
    sprBand: sprBand(sprMed),
    sprSamples: state.sprSamples.length,
    fheMedian: median(state.fheSamples),
    centsSpread: spread(state.centsHist),
    noteNames: null,
  };
}

/** Rozptyl ladění: směrodatná odchylka v centech (jak přesně se drží tón). */
export function spread(cents) {
  if (cents.length < 3) return NaN;
  const m = cents.reduce((a, b) => a + b, 0) / cents.length;
  const v = cents.reduce((a, b) => a + (b - m) * (b - m), 0) / cents.length;
  return Math.sqrt(v);
}

/* ── vyhodnocení pro UI ───────────────────────────────────────────────────── */

export function centsClass(cents) {
  if (cents === null || !Number.isFinite(cents)) return 'none';
  const a = Math.abs(cents);
  return a <= CENTS_OK ? 'ok' : a <= CENTS_MID ? 'mid' : 'bad';
}

export function levelClass(dbfs) {
  if (!Number.isFinite(dbfs)) return 'none';
  if (dbfs < -45) return 'bad';       // skoro nic
  if (dbfs < -30) return 'mid';       // málo
  if (dbfs > -6) return 'bad';        // přebuzeno
  return 'ok';
}

export function sprClass(band) {
  return { profi: 'ok', mezi: 'mid', pod: 'bad' }[band] || 'none';
}
