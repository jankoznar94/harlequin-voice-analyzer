/**
 * Experiment: spektrální odhad f0 metodou subharmonického součtu (SHS, Hermes 1988).
 *
 * Motivace: YIN občas zvolí vyšší harmonickou jako f0 (když je H2 silnější než H1),
 * takže kontura skáče a segmentace se drobí. SHS hledá f0, jehož harmonická řada
 * nejlépe vysvětlí spektrum, takže drží skutečný základní tón.
 */
import { readFileSync } from 'node:fs';
import { fft, hzToNote, hzToCents } from '../src/analysis.js';

export function loadWav(path) {
  const b = readFileSync(path);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = b.subarray(body, body + sz);
    off = body + sz + (sz & 1);
  }
  const n = Math.floor(data.length / (fmt.ch * fmt.bits / 8));
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (let c = 0; c < fmt.ch; c++) a += data.readInt16LE((i * fmt.ch + c) * (fmt.bits / 8)) / 32768;
    x[i] = a / fmt.ch;
  }
  return { samples: x, sampleRate: fmt.sr };
}

/** SHS f0 pro jeden rámec. Vrací Hz nebo 0. */
export function shsFrame(frame, sampleRate, opts = {}) {
  const fMin = opts.fMin ?? 65, fMax = opts.fMax ?? 1000;
  const nHarm = opts.nHarm ?? 14;
  const decay = opts.decay ?? 0.84;
  const N = frame.length;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = frame[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  fft(re, im);
  const half = N >> 1, binHz = sampleRate / N;
  const P = new Float64Array(half);
  let total = 0;
  for (let i = 1; i < half; i++) { P[i] = re[i] * re[i] + im[i] * im[i]; total += P[i]; }
  if (total <= 1e-12) return 0;

  // interpolace výkonu na libovolné frekvenci
  const at = (f) => {
    const x = f / binHz;
    const i = Math.floor(x);
    if (i < 1 || i >= half - 1) return 0;
    const t = x - i;
    return P[i] * (1 - t) + P[i + 1] * t;
  };

  // kandidáti: 48 kroků na půltón
  const lo = Math.log2(fMin), hi = Math.log2(fMax);
  const steps = Math.round((hi - lo) * 48);
  let best = -1, bestF = 0;
  const scores = new Float64Array(steps + 1);
  for (let s = 0; s <= steps; s++) {
    const f = Math.pow(2, lo + s / 48);
    let sc = 0, w = 1, nk = 0;
    for (let k = 1; k <= nHarm; k++) {
      const fk = k * f;
      if (fk > Math.min(5000, sampleRate / 2 - binHz)) break;
      sc += w * at(fk);
      w *= decay; nk++;
    }
    // normalizace počtem harmonických: brání slepé preferenci nízkých f0
    scores[s] = nk ? sc / nk : 0;
    if (scores[s] > best) { best = scores[s]; bestF = f; }
  }
  if (best <= 0) return 0;
  // parabolická interpolace v log-f
  const si = Math.round((Math.log2(bestF) - lo) * 48);
  if (si > 0 && si < steps) {
    const s0 = scores[si - 1], s1 = scores[si], s2 = scores[si + 1];
    const den = s0 - 2 * s1 + s2;
    if (den !== 0) {
      const d = 0.5 * (s0 - s2) / den;
      bestF = Math.pow(2, lo + (si + d) / 48);
    }
  }
  return bestF;
}

/** SHS kontura pro celý signál. */
export function shsTrack(samples, sampleRate, opts = {}) {
  const N = opts.frameSize ?? 4096;
  const hop = opts.hopSize ?? Math.round(0.010 * sampleRate);
  const rmsMin = opts.rmsMin ?? 0.008;
  const nFrames = Math.max(0, Math.floor((samples.length - N) / hop) + 1);
  const times = new Float64Array(nFrames);
  const f0 = new Float64Array(nFrames);
  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * hop;
    times[fi] = (start + N / 2) / sampleRate;
    let rms = 0;
    for (let i = start; i < start + N; i++) rms += samples[i] * samples[i];
    rms = Math.sqrt(rms / N);
    if (rms < rmsMin) { f0[fi] = 0; continue; }
    f0[fi] = shsFrame(samples.subarray(start, start + N), sampleRate, opts);
  }
  return { times, f0 };
}

if (process.argv[1]?.endsWith('pitch-hps.mjs')) {
  const { samples, sampleRate } = loadWav(process.argv[2]);
  const { times, f0 } = shsTrack(samples, sampleRate);
  const T = samples.length / sampleRate;
  console.log('t(s)  SHS kontura po 0,25 s (nota / centová SD)');
  let acc = '';
  let i = 0;
  const out = [];
  for (let t = 0; t + 0.25 <= T; t += 0.25) {
    const v = [];
    for (let k = 0; k < f0.length; k++) if (times[k] >= t && times[k] < t + 0.25 && f0[k] > 0) v.push(f0[k]);
    if (v.length < 3) { out.push(null); continue; }
    v.sort((a, b) => a - b);
    const med = v[v.length >> 1];
    const sd = Math.sqrt(v.reduce((s, x) => s + (1200 * Math.log2(x / med)) ** 2, 0) / v.length);
    out.push([med, sd]);
  }
  for (let k = 0; k < out.length; k++) {
    const o = out[k];
    acc += (o ? (hzToNote(o[0]) + (o[1] > 45 ? '~' : ' ')).padEnd(6) : '.     ');
    if ((k + 1) % 16 === 0) { console.log(String((k - 15) * 0.25).padStart(5) + ' ' + acc); acc = ''; }
  }
  if (acc) console.log('   ... ' + acc);
}
