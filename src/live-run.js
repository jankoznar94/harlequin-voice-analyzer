/**
 * Živý režim v prohlížeči — mikrofon → AudioWorklet → indikátor.
 *
 * PROČ AUDIOWORKLET A NE MediaRecorder NEBO AnalyserNode:
 *   MediaRecorder vydává jen komprimované bloky a ne v reálném čase;
 *   AnalyserNode umí jen FFT bez fáze, ale nedá se z něj číst spojitý proud
 *   vzorků. AudioWorklet je jediná cesta, jak dostat SUROVÉ vzorky po malých
 *   blocích (128 vzorků = 2,7 ms) bez zpoždění.
 *
 * Zpracování běží v hlavním vlákně, ne ve workletu. Důvod: WASM jádro by se
 * muselo načíst i do audio vlákna (další kopie 10 kB + druhá inicializace) a
 * naměřená rezerva je 154×, takže není co zachraňovat. Kdyby se ukázalo, že
 * na telefonu rámec nestíhá, je to jednořádková změna — práce patří do
 * workletu přes `port.postMessage` s přenosem bufferu.
 *
 * POZOR: prohlížeč utlumí zvuk, když přepneš na jinou kartu nebo zhasne
 * displej. Nativní aplikace jede dál, web ne. Indikátor se v tu chvíli zasekne
 * — UI to musí přiznat, ne tiše mlčet.
 */

import { FRAME_SIZE, BLOCK_MS, createLiveState, feedFrame, summarizeLive, centsClass, levelClass, sprClass } from './live.js';
import { createDsp } from './dsp-backend.js';
import {
  loadColors, drawTuning, drawLevel, drawSprHistory, drawFhe, classColor,
  SPR_MIN, SPR_MAX,
} from './live-charts.js';
import { REFS, SPR_NFFT } from './analysis.js';

/** Kolik hodnot SPR se drží pro graf (~20 s při 5 vzorcích/s). */
const SPR_HISTORY = 100;

/** Jak často se smí překreslit číselné údaje (ms). Kresba ručičky je častější. */
const TEXT_MS = 200;

/**
 * Zdrojový kód AudioWorkletu.
 *
 * Worklet jen předává surové vzorky dál — žádná matematika v audio vlákně,
 * aby se nikdy nemuselo čekat na hlavní vlákno. Když hlavní vlákno na chvíli
 * nestíhá, prohlížeč bloky zahodí, ale zvuk zůstane plynulý.
 */
const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;      // nikdy nekončit, dokud nás nezastaví
  }
}
registerProcessor('capture', CaptureProcessor);
`;

/* ── stav modulu ─────────────────────────────────────────────────────────── */

let run = null;          // aktuální běžící měření

export function isLiveRunning() { return !!run; }

/* ── spuštění ────────────────────────────────────────────────────────────── */

/**
 * Spustí živé měření.
 * @param {object} ui  handlery: { onSnapshot(s), onError(msg), onEnd(summary) }
 * @param {string} fach zvolený rozsah nahrávky
 */
export async function startLive(ui, fach = 'tenor') {
  if (run) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // automatické zásahy kazí spektrum — stejné nastavení jako u nahrávání
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (e) {
    ui.onError('Mikrofon se nepodařilo otevřít: ' + (e.message || e.name));
    return;
  }

  const Ctx = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try {
    ctx = new Ctx();
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' })));
  } catch (e) {
    stream.getTracks().forEach(t => t.stop());
    if (ctx) ctx.close().catch(() => {});
    ui.onError('Prohlížeč nepodporuje AudioWorklet, živý režim tady nejde. ' +
      'Nahraj nahrávku místo toho — výsledky budou stejné.');
    return;
  }

  await ctx.resume();

  const sampleRate = ctx.sampleRate;
  let backend;
  try {
    backend = await createDsp({ frameSize: FRAME_SIZE, sampleRate, fach });
  } catch (e) {
    await stopLive();
    ui.onError('Chyba ve výpočetním jádře: ' + (e.message || e));
    return;
  }
  backend.reset();

  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'capture');
  src.connect(node);
  // Worklet musí být připojený k výstupu, jinak ho prohlížeč nespouští.
  // Přes nulový zisk, aby do sluchátek nic nešlo (zpěvák slyší sám sebe =
  // zpětná vazba a navíc to ruší zpěv).
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  const state = createLiveState(sampleRate, FRAME_SIZE);
  const history = [];
  const historyOld = [];

  run = {
    stopping: false,
    state, history, historyOld, backend, ctx, stream, node, src, ui,
    pending: new Float64Array(0),
    sprBuf: new Float64Array(0),      // posledních SPR_NFFT vzorků pro SPR
    lastText: 0,
    framesSinceDraw: 0,
    visible: true,
  };

  // bloky z workletu skládáme do klouzavého okna FRAME_SIZE vzorků
  node.port.onmessage = (ev) => {
    if (!run || run.stopping) return;
    try {
      pushBlock(run, ev.data);
    } catch (e) {
      console.error('živé zpracování selhalo', e);
      stopLive().then(() => ui.onError('Živý režim spadl: ' + (e.message || e)));
    }
  };

  // Když se schová karta, prohlížeč přestane doručovat zvuk. Přiznat to.
  run.onVisibility = () => {
    if (!run) return;
    const hidden = document.visibilityState === 'hidden';
    run.visible = !hidden;
    ui.onVisibilityChange(!hidden);
  };
  document.addEventListener('visibilitychange', run.onVisibility);

  ui.onStarted({ sampleRate, backend: backend.kind, fach });
  return true;
}

/**
 * Složí příchozí bloky do klouzavého okna a posílá hotové rámce ke zpracování.
 *
 * Okno se posouvá o BLOCK_MS, ale zpracovává se vždy FRAME_SIZE vzorků —
 * rámce se tedy překrývají. To je záměr: delší okno dá přesnější výšku,
 * zatímco posun o 20 ms udrží indikátor svižný.
 *
 * POZOR: SPR POTŘEBUJE VLASTNÍ ZÁSOBNÍK, ne `pending`. Ten se po každém rámci
 * ořezává, takže v něm nikdy není víc než ~1,4 rámce vzorků — a okno 4096 by
 * z něj tedy NIKDY nevzniklo (naměřeno: délka `merged` zůstane pod 2880, takže
 * by se SPR nehlásilo vůbec a indikátor by zůstal prázdný). Proto se posledních
 * SPR_NFFT vzorků drží zvlášť v `sprBuf`, který se jen posouvá.
 */
function pushBlock(r, block) {
  const need = Math.round(r.state.sampleRate * BLOCK_MS / 1000);

  // kruhový zásobník pro SPR: připoj blok, nech si posledních SPR_NFFT vzorků
  r.sprBuf = appendKeep(r.sprBuf, block, SPR_NFFT);

  const merged = new Float64Array(r.pending.length + block.length);
  merged.set(r.pending, 0);
  merged.set(block, r.pending.length);

  let off = 0;
  while (merged.length - off >= FRAME_SIZE) {
    const end = off + FRAME_SIZE;
    // okno pro SPR má vždy PLNÝCH SPR_NFFT vzorků; jinak se SPR nehlásí
    const sprWin = r.sprBuf.length >= SPR_NFFT
      ? r.sprBuf.subarray(r.sprBuf.length - SPR_NFFT)
      : null;
    const snap = feedFrame(r.state, r.backend, merged.subarray(off, end), sprWin);
    onFrame(r, snap);
    off += need;
  }
  r.pending = merged.slice(off);
}

/**
 * Připojí blok na konec pole a nechá jen posledních `keep` hodnot.
 *
 * Záměrně bez `slice` na celém dosavadním obsahu: ten by s každým blokem
 * kopíroval celou historii, což je v živém režimu 200× za sekundu zbytečná
 * práce i alokace (a právě alokace rozhazuje garbage collector).
 *
 * POZOR: POSUN OŘEZU SE POČÍTÁ JAKO „KOLIK ZEPŘEDU ZAHODIT“, ne „kolik zezadu
 * nechat“. Napoprvé jsem napsala `buf.length - skip`, což při přetečení
 * nechalo v bufferu NULY (naměřeno: délka sice 4096, ale obsah prázdný) —
 * a přesně nulami doplněné okno je to, co dělá z SPR nesmysl. Hlídá to
 * `test/test-live-buffer.mjs`.
 */
function appendKeep(buf, block, keep) {
  const total = buf.length + block.length;
  if (total <= keep) {
    const out = new Float64Array(total);
    out.set(buf, 0);
    out.set(block, buf.length);
    return out;
  }
  const skip = total - keep;                 // kolik ZEPŘEDU se zahodí
  const dropFromBuf = Math.min(buf.length, skip);
  const out = new Float64Array(keep);
  out.set(buf.subarray(dropFromBuf), 0);
  out.set(block, buf.length - dropFromBuf);
  return out;
}

/** Zpracuje jeden rámec — aktualizuje graf a podle potřeby překreslí. */
function onFrame(r, snap) {
  // do historie jde jen zpívaný rámec, jinak by pauzy dělaly propady.
  // Obě čísla se plní STEJNĚ dlouho, aby se čáry v grafu nekryly posunuté.
  if (snap.voiced) {
    r.history.push(snap.spr);
    if (r.history.length > SPR_HISTORY) r.history.shift();
    if (r.historyOld) {
      r.historyOld.push(snap.sprOld);
      if (r.historyOld.length > SPR_HISTORY) r.historyOld.shift();
    }
  }

  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const wantText = now - r.lastText >= TEXT_MS;

  r.ui.onFrame({
    snap,
    history: r.history,
    historyOld: r.historyOld,
    refreshText: wantText,
    fach: r.state.fach,
  });
  if (wantText) r.lastText = now;
}

/* ── zastavení ───────────────────────────────────────────────────────────── */

export async function stopLive() {
  const r = run;
  if (!r) return null;
  run = null;
  r.stopping = true;

  document.removeEventListener('visibilitychange', r.onVisibility);
  try { r.node.port.onmessage = null; } catch { /* už je pryč */ }
  try { r.node.disconnect(); } catch { /* už je pryč */ }
  try { r.src.disconnect(); } catch { /* už je pryč */ }
  r.stream.getTracks().forEach(t => t.stop());
  try { await r.ctx.close(); } catch { /* už je pryč */ }

  const summary = summarizeLive(r.state);
  summary.backend = r.backend.kind;
  summary.fach = r.state.fach || 'tenor';
  return summary;
}

/** Zastaví a vrátí souhrn — volá se při odchodu ze sekce. */
export async function stopLiveAndSummarize() {
  return stopLive();
}
