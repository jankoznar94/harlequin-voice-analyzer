/**
 * DSP jádro pro analýzu zpěvního hlasu — běží celé v prohlížeči.
 *
 * Implementuje stejné metriky jako referenční Python nástroj (vocal_lab.py),
 * aby se výsledky daly porovnat 1:1:
 *   SPR   — Singing Power Ratio (Omori 1996): peak(2-4k) - peak(0-2k)
 *   FHE   — Frequency of Half Energy (Nature 2022): barva hlasu / fach
 *   ALPHA — alpha ratio: prům. 1-5k minus prům. 50-1000
 *   F0    — YIN (difference function) + mediánové vyhlazení
 *   FORMANTY — LPC Burg + hledání peaků ve LPC spektru
 *   HNR   — z autokorelace
 *
 * Žádné závislosti. Bez WASM. Vše čistý JS.
 */

/* ------------------------------------------------------------------ FFT --- */

const _fftCache = new Map();

/** Iterativní radix-2 FFT. Vrací {re, im} (in-place nad kopií). */
export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT délka musí být mocnina 2');

  // bit-reversal permutace
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    let key = len;
    let tw = _fftCache.get(key);
    if (!tw) {
      tw = { cos: new Float64Array(len / 2), sin: new Float64Array(len / 2) };
      for (let i = 0; i < len / 2; i++) {
        tw.cos[i] = Math.cos(ang * i);
        tw.sin[i] = Math.sin(ang * i);
      }
      _fftCache.set(key, tw);
    }
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * tw.cos[k] - im[i + k + len / 2] * tw.sin[k];
        const vi = re[i + k + len / 2] * tw.sin[k] + im[i + k + len / 2] * tw.cos[k];
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
  return { re, im };
}

/** Výkonové spektrum okna (jednostranné), vrací Float64Array délky N/2. */
function powerSpectrum(frame, win) {
  const n = frame.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * win[i];
  fft(re, im);
  const half = n >> 1;
  const p = new Float64Array(half);
  for (let i = 0; i < half; i++) p[i] = re[i] * re[i] + im[i] * im[i];
  return p;
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}

/* ------------------------------------------------------- SPEKTRÁLNÍ METRIKY - */

/** Long-term average spectrum. Vrací {freq, db} (db = 10*log10 výkon). */
export function ltas(samples, sampleRate, nfft = 4096, hop = null) {
  const n = Math.min(nfft, 1 << Math.floor(Math.log2(samples.length)));
  const frameSize = n;
  const step = hop || frameSize >> 1;
  const win = hann(frameSize);
  const half = frameSize >> 1;
  const acc = new Float64Array(half);
  let count = 0;

  for (let start = 0; start + frameSize <= samples.length; start += step) {
    const frame = samples.subarray(start, start + frameSize);
    const p = powerSpectrum(frame, win);
    for (let i = 0; i < half; i++) acc[i] += p[i];
    count++;
  }
  if (count === 0) return null;

  const freq = new Float64Array(half);
  const db = new Float64Array(half);
  const binHz = sampleRate / frameSize;
  for (let i = 0; i < half; i++) {
    freq[i] = i * binHz;
    db[i] = 10 * Math.log10(acc[i] / count + 1e-20);
  }
  return { freq, db, binHz };
}

/** SPR = peak(2-4 kHz) - peak(0-2 kHz). Vyšší (méně záporný) = víc ringu. */
export function spr(spec) {
  let hiMax = -Infinity, loMax = -Infinity;
  const { freq, db } = spec;
  for (let i = 0; i < freq.length; i++) {
    const f = freq[i];
    if (f >= 2000 && f <= 4000) { if (db[i] > hiMax) hiMax = db[i]; }
    else if (f > 0 && f < 2000) { if (db[i] > loMax) loMax = db[i]; }
  }
  if (hiMax === -Infinity || loMax === -Infinity) return NaN;
  return hiMax - loMax;
}

/** FHE — frekvence, kde kumulativní energie v pásmu dosáhne 50 %. */
export function fhe(spec, lo = 2000, hi = 3600) {
  const { freq, db } = spec;
  let total = 0;
  const idx = [];
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= lo && freq[i] <= hi) {
      const p = Math.pow(10, db[i] / 10);
      total += p;
      idx.push([freq[i], p]);
    }
  }
  if (!idx.length || total <= 0) return NaN;
  let c = 0;
  for (const [f, p] of idx) {
    c += p;
    if (c >= 0.5 * total) return f;
  }
  return idx[idx.length - 1][0];
}

/** Alpha ratio — průměr 1-5 kHz minus průměr 50-1000 Hz (dB). */
export function alphaRatio(spec) {
  let aSum = 0, aN = 0, bSum = 0, bN = 0;
  const { freq, db } = spec;
  for (let i = 0; i < freq.length; i++) {
    const f = freq[i];
    if (f >= 1000 && f <= 5000) { aSum += db[i]; aN++; }
    else if (f >= 50 && f <= 1000) { bSum += db[i]; bN++; }
  }
  if (!aN || !bN) return NaN;
  return aSum / aN - bSum / bN;
}

/** Mezní kmitočet: nejvyšší f, kde spektrum ještě není o dropDb pod vrcholem. */
export function bandwidthLimit(spec, dropDb = 40) {
  const { freq, db } = spec;
  let peak = -Infinity;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= 200 && freq[i] <= 6000 && db[i] > peak) peak = db[i];
  }
  let last = NaN;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= 200 && freq[i] <= 6000 && db[i] > peak - dropDb) last = freq[i];
  }
  return last;
}

/** Je nahrávka vůbec schopna měřit SPR? (úseknuté pásmo = nesmysl) */
export function sprValid(spec, minHz = 4100) {
  const lim = bandwidthLimit(spec);
  if (isNaN(lim)) return { valid: false, reason: 'spektrum nelze vyhodnotit', limit: NaN };
  if (lim < minHz) {
    return {
      valid: false,
      reason: `pásmo useknuto na ~${Math.round(lim)} Hz (potřeba aspoň ${minHz} Hz) - SPR nelze měřit`,
      limit: lim,
    };
  }
  return { valid: true, reason: 'ok', limit: lim };
}

/* --------------------------------------------------------------- F0 (YIN) -- */

/** Inverzní FFT pro reálné sudé spektrum (výsledek je reálný). */
function ifftRealEven(re, im) {
  fft(re, im);
  const n = re.length;
  for (let i = 0; i < n; i++) re[i] /= n;
  return re;
}

/**
 * YIN pro jeden rámec — FFT akcelerovaný.
 *
 * Přímý výpočet difference funkce je O(tauMax²); tudy je O(N log N) přes
 * autokorelaci:  d(tau) = e0 + e(tau) - 2*r(tau)
 * (de Cheveigné & Kawahara 2002)
 */
function yinFrame(frame, sampleRate, fMin, fMax, threshold) {
  const N = frame.length;
  const W = N >> 1;                                  // délka okna pro srovnávání
  const tauMax = Math.min(W, Math.ceil(sampleRate / fMin));
  const tauMin = Math.max(2, Math.floor(sampleRate / fMax));
  if (tauMax <= tauMin + 2) return -1;

  // Vzájemná korelace r(tau) = sum_{i=0}^{W-1} x[i] * x[i+tau]
  // POZOR: musí jít přes STEJNÉ okno W jako energie, jinak je d(tau) nekonzistentní
  // a vychází oktávové chyby.
  const pad = N << 1;
  const ar = new Float64Array(pad), ai = new Float64Array(pad);   // x[0..W-1]
  const br = new Float64Array(pad), bi = new Float64Array(pad);   // x[0..N-1]
  for (let i = 0; i < W; i++) ar[i] = frame[i];
  for (let i = 0; i < N; i++) br[i] = frame[i];
  fft(ar, ai);
  fft(br, bi);
  // A * conj(B)  →  korelace
  const cr = new Float64Array(pad), ci = new Float64Array(pad);
  for (let i = 0; i < pad; i++) {
    cr[i] = ar[i] * br[i] + ai[i] * bi[i];
    ci[i] = ai[i] * br[i] - ar[i] * bi[i];
  }
  ifftRealEven(cr, ci);
  const r = cr;

  // kumulativní energie pro e(tau) v O(1)
  const csum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) csum[i + 1] = csum[i] + frame[i] * frame[i];
  const e0 = csum[W];

  const d = new Float64Array(tauMax);
  for (let tau = 1; tau < tauMax; tau++) {
    const e = csum[tau + W] - csum[tau];
    d[tau] = e0 + e - 2 * r[tau];
    if (d[tau] < 0) d[tau] = 0;
  }

  // kumulativní střední normalizace
  const cmnd = new Float64Array(tauMax);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau < tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? d[tau] * tau / running : 1;
  }

  // absolutní práh
  let tau = -1;
  for (let t = tauMin; t < tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 < tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return -1;

  // parabolická interpolace
  let betterTau = tau;
  if (tau > 0 && tau + 1 < tauMax) {
    const s0 = cmnd[tau - 1], s1 = cmnd[tau], s2 = cmnd[tau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tau + (s2 - s0) / denom;
  }
  return sampleRate / betterTau;
}

/** F0 kontura po rámcích. Vrací {times, f0}. */
export function pitchTrack(samples, sampleRate, opts = {}) {
  // rámec 2048 vzorků → umí i 70 Hz (perioda 630 vzorků) a je rychlý
  const frameSize = opts.frameSize || 2048;
  const hopSize = opts.hopSize || Math.round(0.010 * sampleRate);
  const fMin = opts.fMin || 70;
  const fMax = opts.fMax || 1200;
  const threshold = opts.threshold || 0.15;
  const rmsMin = opts.rmsMin || 0.008;

  const nFrames = Math.max(0, Math.floor((samples.length - frameSize) / hopSize) + 1);
  const times = new Float64Array(nFrames);
  const f0 = new Float64Array(nFrames);

  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * hopSize;
    times[fi] = (start + frameSize / 2) / sampleRate;

    // RMS gate
    let rms = 0;
    for (let i = start; i < start + frameSize; i++) rms += samples[i] * samples[i];
    rms = Math.sqrt(rms / frameSize);
    if (rms < rmsMin) { f0[fi] = 0; continue; }

    const frame = samples.subarray(start, start + frameSize);
    const v = yinFrame(frame, sampleRate, fMin, fMax, threshold);
    f0[fi] = v > 0 ? v : 0;
  }
  return { times, f0 };
}

/**
 * Mediánový filtr pro f0 konturu (potlačí oktávové chyby a vykyvy).
 *
 * DŮLEŽITÉ: nesmí "vymýšlet" znění. Vzorky, které jsou v originále nezpěvné (0),
 * zůstanou nulové — jinak filtr vyplní krátké pauzy mezi tóny a segmentace
 * je pak slije do jednoho tónu.
 */
export function medianFilter(arr, k = 15) {
  const n = arr.length;
  const out = new Float64Array(n);
  const half = k >> 1;
  for (let i = 0; i < n; i++) {
    if (!(arr[i] > 0)) { out[i] = arr[i]; continue; }   // nezpěvné zůstává nezpěvné
    const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
    const w = [];
    for (let j = a; j < b; j++) if (arr[j] > 0) w.push(arr[j]);
    if (!w.length) { out[i] = arr[i]; continue; }
    w.sort((x, y) => x - y);
    out[i] = w.length & 1 ? w[w.length >> 1] : (w[(w.length >> 1) - 1] + w[w.length >> 1]) / 2;
  }
  return out;
}

/* ------------------------------------------------------------- SEGMENTACE -- */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function hzToCents(f) { return f > 0 ? 1200 * Math.log2(f / 440) : NaN; }

export function hzToNote(f) {
  if (!(f > 0)) return '?';
  const midi = Math.round(69 + 12 * Math.log2(f / 440));
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function czPlural(n, one, few, many) {
  const a = Math.abs(n);
  if (a === 1) return one;
  if (a >= 2 && a <= 4) return few;
  return many;
}

/** Rozdělí f0 konturu na tónové události (stejná logika jako Python verze). */
export function segmentNotes(times, f0raw, opts = {}) {
  const tolCents = opts.tolCents ?? 120;
  const minDur = opts.minDur ?? 0.30;
  const gap = opts.gap ?? 0.12;
  const f0 = opts.smooth === false ? f0raw : medianFilter(f0raw, 15);

  const n = f0.length;
  const segs = [];
  let i = 0;
  while (i < n) {
    if (!(f0[i] > 0)) { i++; continue; }
    const start = i;
    const run = [hzToCents(f0[i])];
    let j = i;
    while (j + 1 < n) {
      if (!(f0[j + 1] > 0)) {
        let k = j + 1;
        while (k < n && !(f0[k] > 0) && (times[k] - times[j]) < gap) k++;
        if (k < n && f0[k] > 0) {
          j = k; run.push(hzToCents(f0[j])); continue;
        }
        break;
      }
      const c = hzToCents(f0[j + 1]);
      const mean = run.reduce((a, b) => a + b, 0) / run.length;
      if (Math.abs(c - mean) > tolCents) break;
      j++; run.push(c);
    }
    if (times[j] - times[start] >= minDur) segs.push([times[start], times[j]]);
    i = j + 1;
  }

  // sloučit krátké mezery
  const merged = [];
  for (const s of segs) {
    if (merged.length && s[0] - merged[merged.length - 1][1] < gap) {
      merged[merged.length - 1][1] = s[1];
    } else merged.push([...s]);
  }

  // sloučit oktávové chyby (sousední segmenty vzdálené ~1200 centů = jedna nota)
  const f0Of = (s) => {
    const v = [];
    for (let k = 0; k < times.length; k++) {
      if (times[k] >= s[0] && times[k] <= s[1] && f0[k] > 0) v.push(f0[k]);
    }
    if (!v.length) return -1;
    v.sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  if (merged.length > 1) {
    const fixed = [merged[0]];
    for (let m = 1; m < merged.length; m++) {
      const a = f0Of(fixed[fixed.length - 1]), b = f0Of(merged[m]);
      const dc = (a > 0 && b > 0) ? Math.abs(hzToCents(b) - hzToCents(a)) : 0;
      if (dc > 1000 && dc < 1400) fixed[fixed.length - 1][1] = merged[m][1];
      else fixed.push(merged[m]);
    }
    return fixed.filter(s => s[1] - s[0] >= minDur);
  }
  return merged.filter(s => s[1] - s[0] >= minDur);
}

/* -------------------------------------------------------------------- LPC -- */

/**
 * Burgova metoda LPC. Vrací koeficienty a (bez a[0]=1).
 * Stabilní a přesná i na krátkých rámcích.
 */
export function lpcBurg(x, order) {
  const n = x.length;
  let f = Float64Array.from(x);
  let b = Float64Array.from(x);
  const a = new Float64Array(order + 1);
  a[0] = 1;

  for (let m = 1; m <= order; m++) {
    let num = 0, den = 0;
    for (let i = m; i < n; i++) {
      num += 2 * f[i] * b[i - 1];
      den += f[i] * f[i] + b[i - 1] * b[i - 1];
    }
    const k = den > 1e-12 ? -num / den : 0;
    const nf = new Float64Array(n), nb = new Float64Array(n);
    for (let i = m; i < n; i++) {
      nf[i] = f[i] + k * b[i - 1];
      nb[i] = b[i - 1] + k * f[i];
    }
    f = nf; b = nb;
    const old = Float64Array.from(a);
    a[m] = k;
    for (let i = 1; i < m; i++) a[i] = old[i] + k * old[m - i];
  }
  return a;
}

/** LPC spektrum (obálka 1/|A|) na frekvenční mřížce. */
export function lpcSpectrum(a, sampleRate, nPoints = 512, maxHz = 5500) {
  const out = new Float64Array(nPoints);
  const freqs = new Float64Array(nPoints);
  for (let i = 0; i < nPoints; i++) {
    const f = (i / (nPoints - 1)) * maxHz;
    freqs[i] = f;
    const w = 2 * Math.PI * f / sampleRate;
    let re = 1, im = 0;
    for (let k = 1; k < a.length; k++) {
      re += a[k] * Math.cos(-w * k);
      im += a[k] * Math.sin(-w * k);
    }
    const mag2 = re * re + im * im;
    // POZOR: H(z) = 1/A(z), takže dB obálky je -10*log10|A|².
    // Bez záporného znaménka vycházejí antidíry místo formantů.
    out[i] = -10 * Math.log10(mag2 + 1e-20);
  }
  return { freqs, db: out };
}

/** Najde formanty jako peaky LPC spektra (F1..Fk). */
export function findFormants(a, sampleRate, maxHz = 5500) {
  const { freqs, db } = lpcSpectrum(a, sampleRate, 1024, maxHz);
  const peaks = [];
  for (let i = 1; i < db.length - 1; i++) {
    if (db[i] > db[i - 1] && db[i] >= db[i + 1] && freqs[i] > 150) {
      // parabolická interpolace vrcholu
      const d0 = db[i - 1], d1 = db[i], d2 = db[i + 1];
      const denom = d0 - 2 * d1 + d2;
      const shift = denom !== 0 ? 0.5 * (d0 - d2) / denom : 0;
      peaks.push({ f: freqs[i] + shift * (freqs[1] - freqs[0]), db: d1 });
    }
  }
  peaks.sort((p, q) => p.f - q.f);
  // sloučit peaky blíž než 150 Hz
  const merged = [];
  for (const p of peaks) {
    if (merged.length && p.f - merged[merged.length - 1].f < 150) {
      if (p.db > merged[merged.length - 1].db) merged[merged.length - 1] = p;
    } else merged.push(p);
  }
  return merged.slice(0, 5).map(p => p.f);
}

/** Jednoduchý FIR lowpass (windowed sinc) pro decimaci bez aliasingu. */
function lowpassFir(x, cutoffHz, sampleRate, taps = 63) {
  const fc = cutoffHz / sampleRate;           // normovaná
  const n = x.length;
  const h = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - mid;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    // Blackman okno
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1))
      + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < taps; k++) {
      const j = i - k + mid;
      if (j >= 0 && j < n) v += h[k] * x[j];
    }
    out[i] = v;
  }
  return out;
}

/**
 * Decimace na cílový vzorkovací kmitočet (celočíselný faktor).
 *
 * PROČ: LPC formanty na 44,1 kHz mají póly tak blízko u sebe, že se F1 a F2
 * slijí do jednoho peaku. Při ~10 kHz jsou póly v rovině z dostatečně
 * oddělené. Stejně to dělá Praat (interní resampling) i AURORA.
 */
function decimateTo(x, sampleRate, targetRate) {
  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  if (factor === 1) return { samples: x, rate: sampleRate };
  const cutoff = (sampleRate / factor) * 0.42;      // pod Nyquistem
  const filtered = lowpassFir(x, cutoff, sampleRate);
  const n = Math.floor(x.length / factor);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = filtered[i * factor];
  return { samples: out, rate: sampleRate / factor };
}

/**
 * Formanty metodou LPC Burg ve středu segmentu (medián přes několik rámců).
 * Signál se nejdřív decimuje na ~10 kHz — jinak se F1/F2 slijí.
 * Vrací [F1, F2, F3, ...] nebo [].
 */
export function formantsAt(samples, sampleRate, tStartSample, tEndSample, opts = {}) {
  const targetRate = opts.targetRate || 10000;
  const a0 = tStartSample + Math.round(0.20 * (tEndSample - tStartSample));
  const a1 = tEndSample - Math.round(0.20 * (tEndSample - tStartSample));
  const from = Math.max(0, Math.min(tStartSample, a0));
  const to = Math.min(samples.length, Math.max(a1, from + 1));
  if (to - from < 512) return [];

  const chunk = samples.subarray(from, to);
  const { samples: ds, rate } = decimateTo(chunk, sampleRate, targetRate);

  const order = opts.order || 2 * Math.round(rate / 1000) + 4;   // ~2 formanty/kHz
  const frameSize = Math.round(0.030 * rate);
  const hop = Math.round(0.010 * rate);
  if (ds.length < frameSize) return [];

  const tracks = [];
  for (let s = 0; s + frameSize <= ds.length; s += hop) {
    // preemfáze + Hannovo okno
    const x = new Float64Array(frameSize);
    for (let i = 0; i < frameSize; i++) {
      const v = i === 0 ? ds[s] : ds[s + i] - 0.97 * ds[s + i - 1];
      x[i] = v * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frameSize - 1)));
    }
    const a = lpcBurg(x, order);
    const fs = findFormants(a, rate, Math.min(rate / 2 - 200, 5500));
    if (fs.length) tracks.push(fs);
  }
  if (!tracks.length) return [];

  // sloučit stopy: vezmi medián pro každý řád formantu
  const maxN = Math.max(...tracks.map(t => t.length));
  const out = [];
  for (let k = 0; k < maxN; k++) {
    const vals = [];
    for (const t of tracks) {
      // přiřaď podle pořadí, ale jen rozumné hodnoty
      if (t[k] !== undefined && t[k] > 150 && t[k] < rate / 2 - 200) vals.push(t[k]);
    }
    if (!vals.length) continue;
    vals.sort((a, b) => a - b);
    out.push(vals[vals.length >> 1]);
  }
  return out;
}

/* -------------------------------------------------------------- HNR / JIT -- */

/**
 * HNR z autokorelace (Boersma 1993 - princip jako Praat, zjednodušeně).
 * Vrací dB nebo NaN.
 */
export function hnr(samples, sampleRate, f0) {
  if (!(f0 > 0)) return NaN;
  const period = Math.round(sampleRate / f0);
  const winLen = Math.min(samples.length, period * 6);
  if (winLen < period * 2) return NaN;
  const x = samples.subarray(0, winLen);
  let r0 = 0;
  for (let i = 0; i < winLen; i++) r0 += x[i] * x[i];
  r0 /= winLen;
  if (r0 <= 0) return NaN;
  let rT = 0;
  const lim = winLen - period;
  for (let i = 0; i < lim; i++) rT += x[i] * x[i + period];
  rT /= lim;
  const ratio = Math.min(1 - 1e-9, Math.max(1e-9, rT / r0));
  return 10 * Math.log10(ratio / (1 - ratio));
}

/** Jitter (lokální) v % — směrodatná odchylka period / průměr period. */
export function jitter(times, f0) {
  const v = [];
  for (let i = 0; i < f0.length; i++) if (f0[i] > 0) v.push(1 / f0[i]);
  if (v.length < 4) return NaN;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  let sum = 0;
  for (let i = 1; i < v.length; i++) sum += Math.abs(v[i] - v[i - 1]);
  return (sum / (v.length - 1)) / mean * 100;
}

/* ---------------------------------------------------------------- VIBRATO -- */

export function vibrato(f0, dt) {
  const idx = [];
  for (let i = 0; i < f0.length; i++) if (f0[i] > 0) idx.push(i);
  if (idx.length < 16) return { rate: NaN, extent: NaN };
  const cents = idx.map(i => hzToCents(f0[i]));
  const n = cents.length;
  const mean = cents.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - n / 2) * (cents[i] - mean); den += (i - n / 2) ** 2; }
  const slope = den ? num / den : 0;
  const detrended = cents.map((c, i) => c - (mean + slope * (i - n / 2)));
  // FFT na detrendovaném signálu
  const N = 1 << Math.ceil(Math.log2(n));
  const re = new Float64Array(N), im = new Float64Array(N);
  const w = hann(N);
  for (let i = 0; i < n; i++) re[i] = detrended[i] * w[i];
  fft(re, im);
  const half = N >> 1;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  const binHz = 1 / (N * dt);
  let best = 0, bestI = 0;
  for (let i = 1; i < half; i++) {
    const f = i * binHz;
    if (f >= 3.5 && f <= 9.0 && mag[i] > best) { best = mag[i]; bestI = i; }
  }
  const sorted = Array.from(detrended).sort((a, b) => a - b);
  const p95 = sorted[Math.floor(0.95 * (n - 1))];
  const p05 = sorted[Math.floor(0.05 * (n - 1))];
  return { rate: bestI ? bestI * binHz : NaN, extent: p95 - p05 };
}

/* ---------------------------------------------------------------- KONFIG -- */

export const REFS = {
  SPR: {
    nezpevak: [-22.7, 5.1],
    profesional: [-13.1, 3.8],
    zdroj: 'Omori et al. 1996, J Voice 10:228-235 (n=20 / n=21)',
  },
  FHE: {
    tenor: [2705, 221], baryton: [2454, 206], bas: [2384, 164], sopran: [3092, 284],
    zdroj: 'Nature Sci Rep 2022, n=1723 vzorků profesionálních zpěváků',
  },
  SPR_ring_threshold: -20.0,
  F1_align_tol_pct: 8.0,
  F1_tuning_from_hz: 392.0,
  F1_tuning_from_note: 'G4',
  fach_ranges: {
    tenor: [131.0, 660.0],
    baryton: [98.0, 494.0],
    bas: [82.0, 392.0],
    sopran: [262.0, 1175.0],
    alt: [175.0, 880.0],
    vse: [55.0, 1500.0],
  },
};

/* -------------------------------------------------------------- HLAVNÍ API - */

/**
 * Kompletní analýza nahrávky.
 * @param {Float64Array|Float32Array} samples mono
 * @param {number} sampleRate
 * @param {object} opts { fach, minDur, maxDur, minFreq, maxFreq, onProgress }
 * @returns {object} stejný tvar jako Python report.json
 */
export function analyze(samples, sampleRate, opts = {}) {
  const fach = opts.fach || 'tenor';
  const minDur = opts.minDur ?? 0.30;
  const maxDur = opts.maxDur ?? 12.0;
  const progress = opts.onProgress || (() => {});

  const duration = samples.length / sampleRate;
  progress(0.05, 'Sleduji výšku tónu…');

  const { times, f0 } = pitchTrack(samples, sampleRate);
  progress(0.35, 'Dělím nahrávku na tóny…');

  let spans = segmentNotes(times, f0, { minDur });

  // filtr rozsahu: orchestr/doprovod často leze mimo obor hlasu
  const [lo, hi] = REFS.fach_ranges[fach] || REFS.fach_ranges.tenor;
  const loF = opts.minFreq ?? lo;
  const hiF = opts.maxFreq ?? hi;
  const dropped = [];
  const kept = [];
  for (const [t0, t1] of spans) {
    let med = -1;
    const v = [];
    for (let i = 0; i < times.length; i++) {
      if (times[i] >= t0 && times[i] <= t1 && f0[i] > 0) v.push(f0[i]);
    }
    if (v.length) { v.sort((a, b) => a - b); med = v[v.length >> 1]; }
    if (med <= 0) { dropped.push({ t0, t1, why: 'bez f0' }); continue; }
    if (t1 - t0 > maxDur) dropped.push({ t0, t1, why: `příliš dlouhé (${(t1 - t0).toFixed(1)} s)` });
    else if (med < loF || med > hiF) dropped.push({ t0, t1, why: `${hzToNote(med)} mimo ${fach}` });
    else kept.push([t0, t1]);
  }
  spans = kept;

  progress(0.45, `Měřím ${spans.length} tónů…`);

  const notes = [];
  for (let i = 0; i < spans.length; i++) {
    const [t0, t1] = spans[i];
    const nm = measureNote(samples, sampleRate, times, f0, i + 1, t0, t1);
    if (nm) notes.push(nm);
    if (i % 10 === 0) progress(0.45 + 0.45 * (i / Math.max(1, spans.length)),
      `Měřím tón ${i + 1}/${spans.length}…`);
  }

  progress(0.92, 'Vyhodnocuji ring…');
  const summary = ringAnalysis(notes);
  progress(1.0, 'Hotovo');

  return {
    duration_s: duration, sample_rate: sampleRate, fach,
    n_notes: notes.length, n_dropped: dropped.length,
    notes, summary, refs: REFS,
  };
}

function measureNote(samples, sampleRate, times, f0raw, idx, t0, t1) {
  const dur = t1 - t0;
  const a = t0 + 0.20 * dur;
  const b = t1 - 0.20 * dur;
  const [sa, sb] = (b - a >= 0.08) ? [a, b] : [t0, t1];
  const i0 = Math.max(0, Math.floor(sa * sampleRate));
  const i1 = Math.min(samples.length, Math.ceil(sb * sampleRate));
  if (i1 - i0 < 256) return null;
  const seg = samples.subarray(i0, i1);

  const spec = ltas(seg, sampleRate);
  if (!spec) return null;

  const sv = sprValid(spec);
  const sprVal = sv.valid ? spr(spec) : NaN;

  // SPL relativní
  let rms = 0;
  for (let i = 0; i < seg.length; i++) rms += seg[i] * seg[i];
  rms = Math.sqrt(rms / seg.length);
  const spl = 20 * Math.log10(rms + 1e-12);

  // f0 v tónu
  const tv = [];
  for (let i = 0; i < times.length; i++) {
    if (times[i] >= t0 && times[i] <= t1 && f0raw[i] > 0) tv.push(f0raw[i]);
  }
  const f0s = medianFilter(Float64Array.from(tv), 9);
  const valid = Array.from(f0s).filter(v => v > 0).sort((x, y) => x - y);
  const f0 = valid.length ? valid[valid.length >> 1] : NaN;
  const cents = valid.map(hzToCents);
  const meanC = cents.length ? cents.reduce((x, y) => x + y, 0) / cents.length : NaN;
  const sdC = cents.length > 2
    ? Math.sqrt(cents.reduce((s, c) => s + (c - meanC) ** 2, 0) / cents.length) : NaN;

  const vib = vibrato(f0s, 0.010);

  // formanty
  const fmt = formantsAt(samples, sampleRate, i0, i1);
  const F1 = fmt[0] ?? NaN, F2 = fmt[1] ?? NaN, F3 = fmt[2] ?? NaN;

  // F1:F0 — hodnotí se jen od G4 výš
  const tuningRelevant = f0 >= REFS.F1_tuning_from_hz;
  let err = NaN;
  if (tuningRelevant && f0 > 0 && F1 === F1) {
    const k = Math.max(1, Math.round(F1 / f0));
    if (k * f0 > 0) err = Math.abs(k * f0 - F1) / F1 * 100;
  }

  const hnrV = hnr(seg.length > sampleRate ? samples.subarray(i0, i0 + sampleRate) : seg,
    sampleRate, f0);
  const jit = jitter(null, f0s);

  return {
    idx, t_start: t0, t_end: t1, dur,
    note: hzToNote(f0), f0,
    f0_sd_cents: sdC,
    spl_dbfs: spl,
    spr: sprVal,
    spr_valid: sv.valid, spr_note: sv.reason,
    bandwidth_hz: sv.limit,
    alpha: alphaRatio(spec),
    fhe: fhe(spec),
    hnr: hnrV,
    jitter_pct: jit,
    shimmer_pct: NaN,      // vyžaduje sledování amplitudy po periodách
    f1: F1, f2: F2, f3: F3,
    f1_f0_err_pct: err,
    f1_tuned: (err === err) && err <= REFS.F1_align_tol_pct,
    f1_tuning_relevant: tuningRelevant,
    vib_rate: vib.rate, vib_extent_cents: vib.extent,
    ring_ok: false, ring_dropout: false,
  };
}

/** Ring musí být všudypřítomný → hledá výpadky proti vlastnímu mediánu. */
export function ringAnalysis(notes) {
  const usable = notes.filter(n => n.spr_valid && n.spr === n.spr);
  if (!usable.length) {
    const why = notes.find(n => !n.spr_valid)?.spr_note || 'neznámý důvod';
    return {
      spr_unusable: true, reason: why,
      n_notes: 0, n_notes_total: notes.length, n_notes_excluded: notes.length,
    };
  }
  const s = usable.map(n => n.spr).sort((a, b) => a - b);
  const med = s.length & 1 ? s[s.length >> 1]
    : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2;
  const dev = s.map(v => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = dev.length & 1 ? dev[dev.length >> 1]
    : (dev[(dev.length >> 1) - 1] + dev[dev.length >> 1]) / 2;
  const thr = med - Math.max(3.0, 2.5 * 1.4826 * mad);

  for (const n of usable) {
    n.ring_ok = n.spr >= Math.max(thr, REFS.SPR_ring_threshold);
    n.ring_dropout = n.spr < thr;
  }
  const good = usable.filter(n => n.ring_ok).length;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length);

  const rel = usable.filter(n => n.f1_tuning_relevant && n.f1_f0_err_pct === n.f1_f0_err_pct);
  const fhes = usable.map(n => n.fhe).filter(v => v === v).sort((a, b) => a - b);
  const bands = usable.map(n => n.bandwidth_hz).filter(v => v === v).sort((a, b) => a - b);

  return {
    spr_unusable: false,
    n_notes: usable.length,
    n_notes_total: notes.length,
    n_notes_excluded: notes.length - usable.length,
    spr_median: med,
    spr_mean: mean,
    spr_sd: sd,
    spr_min: s[0], spr_max: s[s.length - 1],
    ring_threshold: thr,
    notes_with_ring: good,
    notes_missing_ring: usable.length - good,
    ring_consistency_pct: 100 * good / usable.length,
    dropout_notes: [...new Set(usable.filter(n => n.ring_dropout).map(n => n.note))].sort(),
    f1_tuning_notes: rel.length,
    f1_aligned_pct: rel.length ? 100 * rel.filter(n => n.f1_tuned).length / rel.length : null,
    fhe_median: fhes.length ? fhes[fhes.length >> 1] : null,
    bandwidth_hz: bands.length ? bands[bands.length >> 1] : null,
  };
}
