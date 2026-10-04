/**
 * Sdílené mocky prohlížeče pro testy, které spouštějí SKUTEČNÝ `src/app.js`.
 *
 * PROČ SDÍLENÉ: app.js se musí testovat celý (statická kontrola nepozná
 * ReferenceError ani to, že se dekóduje špatným API). Každý takový test
 * ale potřebuje stejný mock DOM, Web Audio a <audio>. Když se mock opíše
 * dvakrát, jeden z nich tiše zestárne a testy začnou lhát.
 *
 * Použití:
 *   import { installAppEnv } from './mock-app-env.mjs';
 *   const env = installAppEnv({ offlineSampleRate: 48000 });
 *   await import('file://' + APP);
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── mock canvasu 2D ──────────────────────────────────────────────────── */
export const ctx2d = () => ({
  setTransform() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {},
  stroke() {}, fill() {}, closePath() {}, arc() {}, save() {}, restore() {},
  translate() {}, rotate() {}, setLineDash() {}, fillRect() {}, clearRect() {},
  // `rect` + `clip` používá graf ringu při posuvu (ořez na viditelné okno)
  rect() {}, clip() {},
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData() {}, drawImage() {},
});

/* ── syntetický hlas ──────────────────────────────────────────────────── */

/**
 * Vyrobí vzorky, ze kterých analýza opravdu najde tóny (ne ticho) a jejichž
 * spektrum sahá nad 4,1 kHz, takže pásmo NENÍ useknuté.
 *
 * `cutoffHz` dovolí vyrobit i „potlačené" spektrum — tím se simuluje dekódování
 * na nízkém vzorkovacím kmitočtu, které pásmo 2–4 kHz usekne.
 */
export function synth(seconds = 3.2, sr = 44100, cutoffHz = null) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  const f0s = [196, 247, 294, 392];
  f0s.forEach((f0, k) => {
    const a = Math.round((k * 0.8 + 0.05) * sr);
    const b = Math.min(n, Math.round((k * 0.8 + 0.65) * sr));
    for (let i = a; i < b; i++) {
      const t = i / sr;
      let s = 0;
      for (let h = 1; h < 40; h++) {
        const fh = f0 * h;
        if (fh > sr / 2 - 100) break;
        if (cutoffHz && fh > cutoffHz) break;
        const amp = (1 / h) * (Math.exp(-((fh - 2800) ** 2) / (2 * 900 ** 2))
          + 0.35 * Math.exp(-((fh - 700) ** 2) / (2 * 400 ** 2)));
        s += amp * Math.sin(2 * Math.PI * fh * t);
      }
      const fade = Math.min(1, (i - a) / 500) * Math.min(1, (b - i) / 500);
      out[i] = 0.3 * s * fade;
    }
  });
  return out;
}

function bufferFrom(data, sampleRate) {
  return {
    numberOfChannels: 1, length: data.length, sampleRate,
    getChannelData: () => data,
  };
}

/* ── instalace prostředí ──────────────────────────────────────────────── */

/**
 * @param {object} opts
 * @param {number}  opts.audioSampleRate    kmitočet, na kterém „dekóduje" AudioContext
 * @param {number}  opts.offlineSampleRate  kmitočet OfflineAudioContextu (null = neexistuje)
 * @param {number}  opts.audioCutoffHz      potlačené pásmo v AudioContext cestě
 * @param {boolean} opts.offlineThrows      OfflineAudioContext selže (má se použít záložní cesta)
 * @returns {{el, els, audioEls, objectUrls, errors, used, decodedWith}}
 */
export function installAppEnv(opts = {}) {
  const audioSampleRate = opts.audioSampleRate ?? 44100;
  const offlineSampleRate = opts.offlineSampleRate === undefined ? 48000 : opts.offlineSampleRate;
  const audioCutoffHz = opts.audioCutoffHz ?? null;

  /* ── prvky ── */
  const makeEl = (id) => ({
    id, textContent: '', innerHTML: '', value: '', disabled: false,
    onclick: null, onchange: null, className: '', files: [], style: { setProperty() {} },
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    append() {}, appendChild() {}, remove() {},
    setAttribute() {}, getAttribute: () => null,
    /* `click()` musí existovat — `download()` v app.js ho volá na vytvořeném
     * <a>. Bez něj spadne celé stahování reportu na „a.click is not a function",
     * což vypadá jako chyba kódu, ale je to chyba mocku: skutečný DOM ten
     * element metodu MÁ. Mock bez ní test zneplatní (a přesně to se stalo). */
    click() { if (typeof this.onclick === 'function') this.onclick(); },
    querySelector: () => makeEl('child'), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    getContext: () => ctx2d(),
    clientWidth: 800, clientHeight: 300, width: 800, height: 300,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 300 }),
  });
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };

  globalThis.document = {
    readyState: 'complete',
    getElementById: (id) => el(id),
    createElement: (tag) => makeEl(tag),
    addEventListener() {}, querySelectorAll: () => [], body: makeEl('body'),
  };
  globalThis.window = {
    devicePixelRatio: 2, addEventListener() {}, scrollTo() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };

  /* ── chycené chyby ── */
  const errors = [];
  process.on('uncaughtException', (e) => errors.push(e));
  process.on('unhandledRejection', (e) => errors.push(e));

  /* ── Web Audio ── */
  const used = [];                    // kterými cestami se dekódovalo
  let decodedWith = null;

  class MockAudioContext {
    async decodeAudioData(ab) {
      used.push('audiocontext');
      decodedWith = ab;
      return bufferFrom(synth(3.2, audioSampleRate, audioCutoffHz), audioSampleRate);
    }
    close() { return Promise.resolve(); }
  }
  globalThis.window.AudioContext = MockAudioContext;

  if (offlineSampleRate === null) {
    delete globalThis.window.OfflineAudioContext;
  } else {
    class MockOfflineAudioContext {
      constructor(ch, len, rate) { this.sampleRate = rate; }
      async decodeAudioData(ab) {
        used.push('offline');
        if (opts.offlineThrows) throw new Error('OfflineAudioContext selhal (test)');
        decodedWith = ab;
        return bufferFrom(synth(3.2, offlineSampleRate), offlineSampleRate);
      }
    }
    globalThis.window.OfflineAudioContext = MockOfflineAudioContext;
  }

  /* ── <audio> ── */
  const audioEls = [];
  class MockAudio {
    constructor() {
      this.src = null; this.paused = true; this.currentTime = 0;
      this.duration = 3.2; this.preload = '';
      this._l = {};
      audioEls.push(this);
    }
    addEventListener(type, fn) { (this._l[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this._l[type] = (this._l[type] || []).filter((f) => f !== fn); }
    emit(type) { (this._l[type] || []).slice().forEach((fn) => fn({ target: this })); }
    play() { this.paused = false; this.emit('play'); return Promise.resolve(); }
    pause() { this.paused = true; this.emit('pause'); }
    removeAttribute(a) { if (a === 'src') this.src = null; }
  }
  globalThis.Audio = MockAudio;

  /* ── objektové URL ── */
  const objectUrls = [];
  URL.createObjectURL = (blob) => { const u = 'blob:mock/' + objectUrls.length; objectUrls.push({ url: u, blob }); return u; };
  URL.revokeObjectURL = () => {};

  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.alert = () => {};
  Object.defineProperty(globalThis, 'navigator', { value: {}, writable: true, configurable: true });

  return { el, els, audioEls, objectUrls, errors, used, get decodedWith() { return decodedWith; } };
}
