/**
 * WASM jádro pro živou analýzu zpěvního hlasu (AssemblyScript).
 *
 * Proč WASM a ne jen rychlejší JS: živá zpětná vazba potřebuje rámec každých
 * ~20 ms a v JS každý rámec alokuje ~6 polí Float64Array. To není pomalé
 * výpočtem, ale tím, že garbage collector občas zamrzne — a mrznutí je v živém
 * indikátoru vidět jako cukání. Tady se všechno alokuje JEDNOU při init a dál
 * se jen přepisuje stejná paměť. (Změřeno: rozptyl max/medián 1,1× proti 1,5×
 * u JS, a to včetně toho, že WASM verze nedělá vůbec žádnou alokaci za běhu.)
 *
 * PŘÍSTUP K PAMĚTI: horké smyčky (FFT, YIN) NESMÍ indexovat pole přes
 * `Float64Array[i]`. AssemblyScript pak v každém přístupu načítá globální
 * referenci, z ní dataStart a ještě dělá kontrolu mezí — v těsné smyčce to bylo
 * 12× pomalejší než JS (naměřeno: 2,62 ms proti 0,22 ms na jeden YIN rámec).
 * Proto se pracuje s `usize` ukazateli a `load<f64>`/`store<f64>`.
 *
 * Čísla MUSÍ vycházet stejně jako v src/analysis.js — viz tools/wasm-parity.mjs.
 */

/* ── přístup k paměti přes ukazatele ──────────────────────────────────────── */

@inline function ld(a: usize, i: i32): f64 {
  return load<f64>(a + (<usize>i << 3));
}

@inline function st(a: usize, i: i32, v: f64): void {
  store<f64>(a + (<usize>i << 3), v);
}

/* ── stav (alokuje se jednou) ─────────────────────────────────────────────── */

let N: i32 = 0;              // délka rámce
let W: i32 = 0;              // okno pro srovnání (N/2)
let pad: i32 = 0;            // 2N — délka FFT
let tauMax: i32 = 0;
let tauMin: i32 = 0;
let sr: f64 = 48000.0;
let threshold: f64 = 0.15;

// Držme si i pole (vlastní reference), ať je GC neuklidí, a k tomu ukazatele.
let frameBuf: Float64Array = new Float64Array(0);
let arB: Float64Array = new Float64Array(0);
let aiB: Float64Array = new Float64Array(0);
let brB: Float64Array = new Float64Array(0);
let biB: Float64Array = new Float64Array(0);
let crB: Float64Array = new Float64Array(0);
let ciB: Float64Array = new Float64Array(0);
// Výkonové spektrum MUSÍ mít vlastní buffer. YIN píše svou korelaci do P_CR,
// takže kdyby spektrum bydlelo tamtéž, každé volání yinCompute() by ho přepsalo
// a živý kumulátor by sčítal autokorelaci místo spektra — SPR pak vyjde nesmysl
// (vrchol "nízkého pásma" na 23 Hz, tedy na tau=0).
let spcB: Float64Array = new Float64Array(0);
let csumB: Float64Array = new Float64Array(0);
let dB: Float64Array = new Float64Array(0);
let cmndB: Float64Array = new Float64Array(0);
let winB: Float64Array = new Float64Array(0);
let twCosB: Float64Array = new Float64Array(0);
let twSinB: Float64Array = new Float64Array(0);
let twOffB: Int32Array = new Int32Array(0);
let accB: Float64Array = new Float64Array(0);

let P_FRAME: usize = 0;
let P_AR: usize = 0;
let P_AI: usize = 0;
let P_BR: usize = 0;
let P_BI: usize = 0;
let P_CR: usize = 0;
let P_CI: usize = 0;
let P_SPC: usize = 0;
let P_CSUM: usize = 0;
let P_D: usize = 0;
let P_CMND: usize = 0;
let P_WIN: usize = 0;
let P_TWCOS: usize = 0;
let P_TWSIN: usize = 0;

let twOff: Int32Array = new Int32Array(0);

/** Alokuje trvalé buffery pro danou délku rámce. Volá se při změně konfigurace. */
export function init(frameSize: i32, sampleRate: f64, fMin: f64, fMax: f64, thr: f64): void {
  N = frameSize;
  W = N >> 1;
  pad = N << 1;
  sr = sampleRate;
  threshold = thr;

  tauMax = min(W, i32(Math.ceil(sampleRate / fMin)));
  tauMin = max(2, i32(Math.floor(sampleRate / fMax)));
  if (tauMax < 0) tauMax = 0;

  frameBuf = new Float64Array(N);
  arB = new Float64Array(pad);
  aiB = new Float64Array(pad);
  brB = new Float64Array(pad);
  biB = new Float64Array(pad);
  crB = new Float64Array(pad);
  ciB = new Float64Array(pad);
  spcB = new Float64Array(N >> 1);
  csumB = new Float64Array(N + 1);
  dB = new Float64Array(tauMax);
  cmndB = new Float64Array(tauMax);
  accB = new Float64Array(N >> 1);

  // Hannovo okno (pro spektrální metr na stejném rámci)
  winB = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    winB[i] = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * f64(i) / f64(N - 1));
  }

  // Twiddle tabulky — stupně len = 2, 4, 8, … pad
  let stages = 0;
  for (let len = 2; len <= pad; len <<= 1) stages++;
  twOff = new Int32Array(stages + 1);
  let total = 0;
  let s = 0;
  for (let len = 2; len <= pad; len <<= 1) {
    twOff[s] = total;
    total += len >> 1;
    s++;
  }
  twOff[stages] = total;
  twCosB = new Float64Array(total);
  twSinB = new Float64Array(total);

  s = 0;
  for (let len = 2; len <= pad; len <<= 1) {
    const ang = -2.0 * Math.PI / f64(len);
    const half = len >> 1;
    const off = twOff[s];
    for (let i = 0; i < half; i++) {
      twCosB[off + i] = Math.cos(ang * f64(i));
      twSinB[off + i] = Math.sin(ang * f64(i));
    }
    s++;
  }

  // ukazatele — odsud dál se do horkých smyček dostane jen usize
  P_FRAME = changetype<usize>(frameBuf.dataStart);
  P_AR = changetype<usize>(arB.dataStart);
  P_AI = changetype<usize>(aiB.dataStart);
  P_BR = changetype<usize>(brB.dataStart);
  P_BI = changetype<usize>(biB.dataStart);
  P_CR = changetype<usize>(crB.dataStart);
  P_CI = changetype<usize>(ciB.dataStart);
  P_SPC = changetype<usize>(spcB.dataStart);
  P_CSUM = changetype<usize>(csumB.dataStart);
  P_D = changetype<usize>(dB.dataStart);
  P_CMND = changetype<usize>(cmndB.dataStart);
  P_WIN = changetype<usize>(winB.dataStart);
  P_TWCOS = changetype<usize>(twCosB.dataStart);
  P_TWSIN = changetype<usize>(twSinB.dataStart);
}

/** Ukazatel na vstupní buffer rámce — JS do něj píše vzorky přímo. */
export function inputPtr(): usize {
  return changetype<usize>(frameBuf.dataStart);
}

/** Ukazatel na buffer výstupního spektra (N/2 hodnot výkonu). */
export function specPtr(): usize {
  return P_SPC;
}

export function specLength(): i32 {
  return N >> 1;
}

export function tauMaxOut(): i32 {
  return tauMax;
}

/* ── FFT (radix-2 in-place, přes ukazatele) ───────────────────────────────── */

function fftPtr(re: usize, im: usize, n: i32): void {
  // bit-reversal permutace
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) != 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = ld(re, i); st(re, i, ld(re, j)); st(re, j, tr);
      const ti = ld(im, i); st(im, i, ld(im, j)); st(im, j, ti);
    }
  }
  let stage = 0;
  for (let len = 2; len <= n; len <<= 1) {
    const off = twOff[stage];
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const c = ld(P_TWCOS, off + k);
        const s = ld(P_TWSIN, off + k);
        const ur = ld(re, i + k);
        const ui = ld(im, i + k);
        const ar2 = ld(re, i + k + half);
        const ai2 = ld(im, i + k + half);
        const vr = ar2 * c - ai2 * s;
        const vi = ar2 * s + ai2 * c;
        st(re, i + k, ur + vr);
        st(im, i + k, ui + vi);
        st(re, i + k + half, ur - vr);
        st(im, i + k + half, ui - vi);
      }
    }
    stage++;
  }
}

/* ── YIN ──────────────────────────────────────────────────────────────────── */

/**
 * Vypočte f0 z rámce, který je v inputPtr(). Vrací Hz, nebo -1 když není tón.
 * Stejný postup jako yinFrame() v JS — včetně stejného okna W pro energii.
 */
export function yinCompute(): f64 {
  const frame = P_FRAME;
  if (tauMax <= tauMin + 2) return -1.0;

  for (let i = 0; i < pad; i++) {
    st(P_AR, i, 0.0); st(P_AI, i, 0.0);
    st(P_BR, i, 0.0); st(P_BI, i, 0.0);
  }
  for (let i = 0; i < W; i++) st(P_AR, i, ld(frame, i));
  for (let i = 0; i < N; i++) st(P_BR, i, ld(frame, i));

  fftPtr(P_AR, P_AI, pad);
  fftPtr(P_BR, P_BI, pad);

  for (let i = 0; i < pad; i++) {
    const arv = ld(P_AR, i), aiv = ld(P_AI, i);
    const brv = ld(P_BR, i), biv = ld(P_BI, i);
    st(P_CR, i, arv * brv + aiv * biv);
    st(P_CI, i, aiv * brv - arv * biv);
  }
  // inverzní FFT (jen reálná část) + normalizace 1/pad
  fftPtr(P_CR, P_CI, pad);
  const inv = 1.0 / f64(pad);
  for (let i = 0; i < pad; i++) st(P_CR, i, ld(P_CR, i) * inv);

  // kumulativní energie
  st(P_CSUM, 0, 0.0);
  for (let i = 0; i < N; i++) {
    const x = ld(frame, i);
    st(P_CSUM, i + 1, ld(P_CSUM, i) + x * x);
  }
  const e0 = ld(P_CSUM, W);

  for (let tau = 1; tau < tauMax; tau++) {
    const e = ld(P_CSUM, tau + W) - ld(P_CSUM, tau);
    let dd = e0 + e - 2.0 * ld(P_CR, tau);
    if (dd < 0.0) dd = 0.0;
    st(P_D, tau, dd);
  }

  st(P_CMND, 0, 1.0);
  let running = 0.0;
  for (let tau = 1; tau < tauMax; tau++) {
    const dv = ld(P_D, tau);
    running += dv;
    st(P_CMND, tau, running > 0.0 ? dv * f64(tau) / running : 1.0);
  }

  let tau = -1;
  for (let t = tauMin; t < tauMax; t++) {
    if (ld(P_CMND, t) < threshold) {
      while (t + 1 < tauMax && ld(P_CMND, t + 1) < ld(P_CMND, t)) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return -1.0;

  let betterTau = f64(tau);
  if (tau > 0 && tau + 1 < tauMax) {
    const s0 = ld(P_CMND, tau - 1), s1 = ld(P_CMND, tau), s2 = ld(P_CMND, tau + 1);
    const denom = 2.0 * (2.0 * s1 - s2 - s0);
    if (denom != 0.0) betterTau = f64(tau) + (s2 - s0) / denom;
  }
  return sr / betterTau;
}

/**
 * Výkonové spektrum rámce z inputPtr() do specPtr().
 * Stejné jako powerSpectrum() v JS (Hannovo okno, |X|²).
 */
export function powerSpectrum(): void {
  const frame = P_FRAME;
  for (let i = 0; i < N; i++) {
    st(P_AR, i, ld(frame, i) * ld(P_WIN, i));
    st(P_AI, i, 0.0);
  }
  fftPtr(P_AR, P_AI, N);
  const half = N >> 1;
  for (let i = 0; i < half; i++) {
    const r = ld(P_AR, i), m = ld(P_AI, i);
    st(P_SPC, i, r * r + m * m);
  }
}

/** RMS rámce z inputPtr() — obálka hlasitosti pro živý indikátor. */
export function rms(): f64 {
  const frame = P_FRAME;
  let s = 0.0;
  for (let i = 0; i < N; i++) {
    const x = ld(frame, i);
    s += x * x;
  }
  return Math.sqrt(s / f64(N));
}

/* ── živý režim ───────────────────────────────────────────────────────────── */

/**
 * Kumulátor výkonového spektra pro klouzavý odhad SPR/FHE.
 *
 * Jeden 42ms rámec je pro SPR příliš krátký — hodnota skáče o desítky dB podle
 * toho, jak zrovna sedí fáze. Proto se sčítá spektrum přes posledních ~0,6 s
 * a metriky se počítají z průměru (obdoba LTAS, jen krátká).
 */
let accCount: i32 = 0;
let accInit: bool = false;

/**
 * Vyhlazovací konstanta kumulátoru. Není to obyčejný součet — ten by se přes
 * celé sezení rozplizl a indikátor by přestal reagovat na to, co se děje teď.
 * Exponenciální vyhlazení drží paměť ~1/α rámců (0,12 → ~8 rámců ≈ 0,17 s),
 * takže hodnota sleduje hlas a zároveň nekmítá z rámce na rámec.
 */
const ACC_ALPHA: f64 = 0.12;

/** Přičte naposledy spočítané spektrum do kumulátoru (volá se jen když se zpívá). */
export function liveAccumulate(): void {
  ensureAcc();
  const half = N >> 1;
  const acc = changetype<usize>(accB.dataStart);
  if (!accInit) {
    for (let i = 0; i < half; i++) st(acc, i, ld(P_SPC, i));
    accInit = true;
  } else {
    const keep = 1.0 - ACC_ALPHA;
    for (let i = 0; i < half; i++) st(acc, i, keep * ld(acc, i) + ACC_ALPHA * ld(P_SPC, i));
  }
  accCount++;
}

/**
 * Kumulátor se vytváří líně. Kdyby se spoléhalo na to, že liveReset() vždy
 * přijde první, stačí jedno vynechané volání a WASM zapisuje mimo přidělenou
 * paměť — což se projeví jako `abort` bez jakékoli stopy o příčině.
 */
function ensureAcc(): void {
  if (accB.length != (N >> 1)) { accB = new Float64Array(N >> 1); accInit = false; }
}

export function liveReset(): void {
  ensureAcc();
  for (let i = 0; i < accB.length; i++) accB[i] = 0.0;
  accCount = 0;
  accInit = false;
}

/** Ukazatel na kumulátor spektra (N/2 hodnot). */
export function accPtr(): usize {
  return changetype<usize>(accB.dataStart);
}

export function accCountOut(): i32 {
  return accCount;
}

/**
 * Zpracuje jeden živý rámec z inputPtr(): spočítá výkonové spektrum a výšku.
 * Spektrum se do kumulátoru NEPŘIČÍTÁ — to dělá až liveAccumulate(). Kdyby se
 * přičítalo tady, započítaly by se i tiché rámce a SPR by se uměle srazilo.
 */
export function liveProcess(): f64 {
  ensureAcc();
  powerSpectrum();
  return yinCompute();
}
