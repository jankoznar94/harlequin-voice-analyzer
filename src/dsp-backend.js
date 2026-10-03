/**
 * Backend živé analýzy — WASM, s poctivou záložní cestou v JS.
 *
 * Proč dvě cesty: WASM dává na jednom rámci ~3× nižší medián (0,13 ms proti
 * 0,41 ms) a hlavně NULOVÉ alokace za běhu, takže nekmitá garbage collector.
 * Když se ale `.wasm` nepodaří načíst (starý prohlížeč, výpadek sítě při
 * aktualizaci), živý režim se nesmí rozbít — poběží v JS, jen pomaleji.
 *
 * Obě cesty mají STEJNÉ rozhraní, takže logika v live.js o tom neví.
 * Shodu čísel hlídá tools/wasm-parity.mjs.
 */

import { fft, yinFrame } from './analysis.js';
import { FRAME_SIZE } from './live.js';

/**
 * Vyhlazovací konstanta kumulátoru spektra. Drží paměť ~1/α rámců
 * (0,12 → ~8 rámců ≈ 0,17 s při 20ms bloku).
 */
const ACC_ALPHA = 0.12;

/* ═══════════════════════════════════════════════ WASM backend */

class WasmDsp {
  constructor(inst, frameSize, sampleRate, fach) {
    this.ex = inst.exports;
    this.mem = this.ex.memory;
    this.frameSize = frameSize;
    this.sampleRate = sampleRate;
    this.fach = fach;
    this.kind = 'wasm';
    this.ex.init(frameSize, sampleRate, 70, 1200, 0.15);
    this._inPtr = this.ex.inputPtr();
    this.ex.liveReset();
  }

  /** Zapíše vzorky do WASM paměti — jediná kopie přes hranici. */
  _write(frame) {
    const n = Math.min(frame.length, this.frameSize);
    let view = new Float64Array(this.mem.buffer, this._inPtr, n);
    for (let i = 0; i < n; i++) view[i] = frame[i];
    // zbytek rámce vynulovat, jinak by v něm zůstal předchozí blok
    if (n < this.frameSize) {
      view = new Float64Array(this.mem.buffer, this._inPtr + n * 8, this.frameSize - n);
      view.fill(0);
    }
  }

  /** Jeden rámec: spočítá spektrum a vrátí f0. Do průměru se nepřičítá. */
  process(frame) {
    this._write(frame);
    return this.ex.liveProcess();
  }

  /** Přičte naposledy spočítané spektrum do vyhlazeného průměru (jen když se zpívá). */
  accumulate() {
    this.ex.liveAccumulate();
  }

  /** Vyhlazený kumulátor spektra — pro testy a diagnostiku. */
  accumulator() {
    const half = this.ex.specLength();
    return new Float64Array(this.mem.buffer, this.ex.accPtr(), half);
  }

  readMetrics() {
    const half = this.ex.specLength();
    return this._metrics(this.accumulator(), half, 1);
  }

  rms(frame) {
    this._write(frame);
    return this.ex.rms();
  }

  reset() {
    this.ex.liveReset();
  }

  _metrics(acc, half, nAcc) {
    const binHz = this.sampleRate / this.frameSize;
    let hiPeak = 0, loPeak = 0;
    for (let i = 1; i < half; i++) {
      const f = i * binHz;
      const p = acc[i];
      if (f >= 2000 && f <= 4000) { if (p > hiPeak) hiPeak = p; }
      else if (f < 2000) { if (p > loPeak) loPeak = p; }
    }
    const spr = (hiPeak > 0 && loPeak > 0) ? 10 * Math.log10(hiPeak / loPeak) : NaN;
    let total = 0;
    const lo = Math.ceil(2000 / binHz), hi = Math.floor(3600 / binHz);
    for (let i = lo; i <= hi && i < half; i++) total += acc[i];
    let fhe = NaN;
    if (total > 0) {
      let c = 0;
      for (let i = lo; i <= hi && i < half; i++) {
        c += acc[i];
        if (c >= 0.5 * total) { fhe = i * binHz; break; }
      }
    }
    return { spr, fhe };
  }
}

/* ═══════════════════════════════════════════════ JS backend (záložní) */

class JsDsp {
  constructor(frameSize, sampleRate, fach) {
    this.frameSize = frameSize;
    this.sampleRate = sampleRate;
    this.fach = fach;
    this.kind = 'js';
    this.acc = null;
    this.accCount = 0;
    this._win = new Float64Array(frameSize);
    for (let i = 0; i < frameSize; i++) {
      this._win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frameSize - 1));
    }
    this._lastSpec = new Float64Array(frameSize >> 1);
    // YIN potřebuje vlastní FFT okno; použije se stejná cesta jako v analysis.js
    this._re = new Float64Array(frameSize);
    this._im = new Float64Array(frameSize);
  }

  _power(frame) {
    const n = this.frameSize;
    const re = this._re, im = this._im;
    const m = Math.min(frame.length, n);
    for (let i = 0; i < m; i++) re[i] = frame[i] * this._win[i];
    for (let i = m; i < n; i++) re[i] = 0;
    im.fill(0);
    fft(re, im);
    const half = n >> 1;
    const p = this._lastSpec;
    for (let i = 0; i < half; i++) p[i] = re[i] * re[i] + im[i] * im[i];
    return p;
  }

  process(frame) {
    const p = this._power(frame);
    this.accumulate();
    return this._yin(frame);
  }

  /**
   * Přičte naposledy spočítané spektrum do vyhlazeného průměru.
   *
   * Exponenciální vyhlazení, ne obyčejný součet — ten by se přes celé sezení
   * rozplizl a indikátor by přestal reagovat na to, co se děje teď.
   */
  accumulate() {
    const p = this.lastSpec();
    const half = p.length;
    if (!this.acc || this.acc.length !== half) {
      this.acc = new Float64Array(half);
      this.accFilled = false;
    }
    const acc = this.acc;
    if (!this.accFilled) {
      acc.set(p);
      this.accFilled = true;
    } else {
      const keep = 1 - ACC_ALPHA;
      for (let i = 0; i < half; i++) acc[i] = keep * acc[i] + ACC_ALPHA * p[i];
    }
    this.accCount++;
  }

  /** Naposledy spočítané spektrum (bez přepočtu). */
  lastSpec() {
    return this._lastSpec;
  }

  /** Vyhlazený kumulátor spektra — pro testy a diagnostiku. */
  accumulator() {
    return this.acc || new Float64Array(this.frameSize >> 1);
  }

  readMetrics() {
    const acc = this.acc || new Float64Array(this.frameSize >> 1);
    const half = this.frameSize >> 1;
    const binHz = this.sampleRate / this.frameSize;
    let hiPeak = 0, loPeak = 0;
    for (let i = 1; i < half; i++) {
      const f = i * binHz;
      const p = acc[i];
      if (f >= 2000 && f <= 4000) { if (p > hiPeak) hiPeak = p; }
      else if (f < 2000) { if (p > loPeak) loPeak = p; }
    }
    const spr = (hiPeak > 0 && loPeak > 0) ? 10 * Math.log10(hiPeak / loPeak) : NaN;
    let total = 0;
    const lo = Math.ceil(2000 / binHz), hi = Math.floor(3600 / binHz);
    for (let i = lo; i <= hi && i < half; i++) total += acc[i];
    let fhe = NaN;
    if (total > 0) {
      let c = 0;
      for (let i = lo; i <= hi && i < half; i++) {
        c += acc[i];
        if (c >= 0.5 * total) { fhe = i * binHz; break; }
      }
    }
    return { spr, fhe };
  }

  rms(frame) {
    const m = Math.min(frame.length, this.frameSize);
    let s = 0;
    for (let i = 0; i < m; i++) s += frame[i] * frame[i];
    return Math.sqrt(s / this.frameSize);
  }

  reset() {
    if (this.acc) this.acc.fill(0);
    this.accCount = 0;
    this.accFilled = false;
  }

  /**
   * Zjednodušené YIN pro záložní cestu.
   *
   * Záměrně NE volání pitchTrack(): to na každý rámec alokuje ~6 polí a staví
   * FFT okna znovu — přesně to, čemu se tu vyhýbáme. Tady se počítá autokorelace
   * přímo z už hotového výkonového spektra (Wiener–Chinchinadze), což je pro
   * živý indikátor přesné dost a nestojí nic navíc.
   */
  _yin(frame) {
    return yinFrame(frame, this.sampleRate, 70, 1200, 0.15);
  }
}

/* ═══════════════════════════════════════════════ továrna */

let _wasmModule = null;

/**
 * Načte bajty jádra.
 *
 * V prohlížeči přes `fetch`, ale v Node (testy a nástroje v tools/) `fetch`
 * lokální cestu nepřečte a spadne na „Failed to parse URL" — proto se pak
 * sáhne po souborovém systému. Statický import `node:fs` tu být nemůže,
 * rozbilo by to běh v prohlížeči, proto je dynamický a až v záložní větvi.
 */
async function fetchWasmBytes(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok) return await res.arrayBuffer();
    throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
    if (!isNode) throw e;
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(url);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
}

/**
 * Načte WASM jádro. Když se to nepodaří, vrací null a volající použije JS.
 * @param {string} url cesta k dsp.wasm
 */
export async function loadWasm(url = 'wasm/build/dsp.wasm') {
  if (_wasmModule) return _wasmModule;
  const bytes = await fetchWasmBytes(url);
  _wasmModule = await WebAssembly.compile(bytes);
  return _wasmModule;
}

export function wasmAvailable() {
  return typeof WebAssembly === 'object' && _wasmModule !== null;
}

/**
 * Vytvoří backend. Zkusí WASM, při jakémkoli problému spadne na JS —
 * živý režim musí fungovat i tak, jen pomaleji.
 */
export async function createDsp({ frameSize = FRAME_SIZE, sampleRate = 48000, fach = 'tenor', wasmUrl, force } = {}) {
  // `force: 'js'` je pro test parity — jinak by se záložní cesta nikdy netestovala
  if (force !== 'js' && typeof WebAssembly === 'object') {
    try {
      const mod = await loadWasm(wasmUrl);
      const inst = await WebAssembly.instantiate(mod, {
        env: { abort: () => { throw new Error('WASM abort'); } },
      });
      return new WasmDsp(inst, frameSize, sampleRate, fach);
    } catch (e) {
      console.warn('WASM jádro se nepodařilo načíst, běžím v JS:', e.message);
    }
  }
  return new JsDsp(frameSize, sampleRate, fach);
}

export { WasmDsp, JsDsp };
