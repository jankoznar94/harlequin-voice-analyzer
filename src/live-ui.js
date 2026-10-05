/**
 * Propojení živého režimu s UI — ovládání, kreslení, ukládání.
 *
 * Drží se stejných pravidel jako zbytek aplikace: stav jen při kliknutí
 * (žádné hover/focus), ploché tónování, žádné emoji, stručné hlášky.
 */

import { isLiveRunning, startLive, stopLive } from './live-run.js';
import {
  loadColors, drawTuning, drawLevel, drawSprHistory, drawFhe,
  COLORS, classColor,
} from './live-charts.js';
import { centsClass, levelClass, sprClass, sprBand, fheBand } from './live.js';
import { REFS } from './analysis.js';

const $ = (id) => document.getElementById(id);

/** Odkazy na prvky — hledají se jednou při prvním otevření. */
let el = null;
let saveHandler = null;      // předá app.js, aby živé měření šlo uložit do historie
let startedAt = 0;

function cacheEls() {
  if (el) return el;
  el = {
    panel: $('panel-live'),
    panelInput: $('panel-input'),
    btnLive: $('btn-live'),
    btnStop: $('btn-live-stop'),
    btnSave: $('btn-live-save'),
    engine: $('live-engine'),
    warn: $('live-warn'),
    tune: $('c-live-tune'),
    spr: $('c-live-spr'),
    level: $('c-live-level'),
    fhe: $('c-live-fhe'),
    note: $('lv-note'), cents: $('lv-cents'), f0: $('lv-f0'),
    sprNow: $('lv-spr'), sprMed: $('lv-sprmed'), fheVal: $('lv-fhe'),
    vtl: $('lv-vtl'),
    lvl: $('lv-lvl'), spread: $('lv-spread'), pct: $('lv-pct'), time: $('lv-time'),
  };
  return el;
}

function fmtDb(v, digits = 1) {
  return Number.isFinite(v) ? `${v.toFixed(digits)} dB` : '—';
}

/* ── textové údaje ───────────────────────────────────────────────────────── */

function setText(node, text, cls = 'none') {
  if (!node) return;
  node.textContent = text;
  node.style.color = cls && cls !== 'none' ? classColor(cls) : '';
}

function updateNumbers(snap, fach) {
  const e = cacheEls();
  const voiced = snap.voiced;

  setText(e.note, voiced && snap.note ? snap.note : '—');
  setText(e.cents, voiced && Number.isFinite(snap.cents)
    ? `${snap.cents >= 0 ? '+' : '−'}${Math.abs(snap.cents).toFixed(0)} c`
    : '—', centsClass(snap.cents));
  setText(e.f0, voiced && snap.f0 > 0 ? `${snap.f0.toFixed(1)} Hz` : '—');
  setText(e.sprNow, fmtDb(snap.spr), sprClass(snap.sprBand));
  setText(e.sprMed, fmtDb(snap.sprMedian), sprClass(sprBand(snap.sprMedian)));

  if (Number.isFinite(snap.fhe)) {
    const band = fheBand(snap.fhe, fach);
    setText(e.fhe, `${Math.round(snap.fhe)} Hz`,
      band === 'ok' ? 'ok' : band === 'none' ? 'none' : 'mid');
  } else setText(e.fhe, '—');

  const lcls = levelClass(snap.dbfs);
  setText(e.lvl, Number.isFinite(snap.dbfs) ? `${snap.dbfs.toFixed(0)} dB` : '—', lcls);

  /* Délka vokálního traktu. Dokud je oken málo, je `snap.vtl` NaN a zůstane
   * „—" — číslo z jednoho okna kolísá o ±1 cm a hlásit ho jako měření by
   * lhalo. Barvu NEMÁ: mimo fyziologický rozsah se sem číslo vůbec nedostane
   * (filtr je v `noteTraktu`), takže není co obarvovat na červeno. */
  setText(e.vtl, Number.isFinite(snap.vtl) ? `${snap.vtl.toFixed(1)} cm` : '—');
}

/* ── kreslení jednoho snímku ─────────────────────────────────────────────── */

function render(ctxData) {
  const e = cacheEls();
  const { snap, history, historyOld, fach } = ctxData;

  drawTuning(e.tune, {
    // Na ručičku jde VYHLAZENÁ odchylka — surová skáče o desítky centů
    // (viz CENTS_SMOOTH_ALPHA v live.js). Když vyhlazená není, použije se surová.
    cents: snap.centsShown ?? snap.cents, note: snap.note, voiced: snap.voiced,
    cls: centsClass(snap.centsShown ?? snap.cents),
  });
  drawSprHistory(e.spr, {
    history,
    historyOld,
    refs: [
      [REFS.SPR.profesional[0], COLORS.dim],
      [REFS.SPR.nezpevak[0], COLORS.mute],
    ],
  });
  drawLevel(e.level, { dbfs: snap.dbfs, cls: levelClass(snap.dbfs) });
  drawFhe(e.fhe, {
    fheHz: snap.fhe,
    ref: REFS.FHE[fach] ? [REFS.FHE[fach][0], REFS.FHE[fach][1]] : null,
    band: fheBand(snap.fhe, fach),
  });
}

/* ── ovládání ────────────────────────────────────────────────────────────── */

export function initLive(saveToHistory) {
  saveHandler = saveToHistory;
  const e = cacheEls();
  if (!e.btnLive) return;

  e.btnLive.onclick = toggleLive;
  e.btnStop.onclick = () => finishLive(false);
  e.btnSave.onclick = () => finishLive(true);
}

async function toggleLive() {
  const e = cacheEls();
  if (isLiveRunning()) { await finishLive(false); return; }

  loadColors();
  e.warn.classList.add('hidden');
  e.engine.textContent = '';
  e.panelInput.classList.add('hidden');
  e.panel.classList.remove('hidden');
  e.btnLive.disabled = true;
  e.btnLive.textContent = 'Spouštím…';

  const fach = $('fach').value;
  const okStart = await startLive({
    onStarted: ({ sampleRate, backend }) => {
      e.btnLive.disabled = false;
      e.btnLive.textContent = 'Živě';
      e.engine.textContent = backend === 'wasm'
        ? `WASM jádro · ${(sampleRate / 1000).toFixed(1)} kHz`
        : `JS jádro (WASM se nenačetl) · ${(sampleRate / 1000).toFixed(1)} kHz`;
      startedAt = Date.now();
    },
    onFrame: (data) => {
      render(data);
      if (data.refreshText) {
        updateNumbers(data.snap, data.fach || fach);
        const secs = Math.round((Date.now() - startedAt) / 1000);
        cacheEls().time.textContent =
          `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
        const pct = data.snap.frames ? Math.round(100 * data.snap.voicedFrames / data.snap.frames) : 0;
        cacheEls().pct.textContent = pct + ' %';
      }
    },
    onVisibilityChange: (visible) => {
      const w = cacheEls().warn;
      if (visible) w.classList.add('hidden');
      else {
        w.textContent = 'Prohlížeč utlumil zvuk, protože jsi přepnul jinam nebo ' +
          'zhasl displej. Měření teď nic neslyší — vrať se do aplikace.';
        w.classList.remove('hidden');
      }
    },
    onError: (msg) => {
      e.btnLive.disabled = false;
      e.btnLive.textContent = 'Živě';
      e.warn.textContent = msg;
      e.warn.classList.remove('hidden');
    },
  }, fach);

  if (!okStart) {
    e.btnLive.disabled = false;
    e.btnLive.textContent = 'Živě';
    if (!e.warn.textContent) {
      e.panel.classList.add('hidden');
      e.panelInput.classList.remove('hidden');
    }
  }
}

async function finishLive(save) {
  const e = cacheEls();
  const summary = await stopLive();
  e.btnLive.disabled = false;
  e.btnLive.textContent = 'Živě';
  e.panel.classList.add('hidden');
  e.panelInput.classList.remove('hidden');

  if (!summary) return;

  // Rozptyl ladění i medián SPR už nese souhrn z summarizeLive() — nic se
  // dopočítávat nemusí.
  if (save && saveHandler) saveHandler(summary);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
