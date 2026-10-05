/* Které metriky přežijí ořez pásma — měřeno na spektru celé nahrávky.
 * Zajímá: FHE (2–3,6 kHz), alpha ratio (1–5 kHz), HNR, hlasitost, počet tónů.
 * (SPR a ring 2–4 kHz potřebují, to je jasné.) */
import { execFileSync } from 'node:child_process';
import { ltas, fhe, alphaRatio } from '/home/martin_fabian/vocal-lab-app/src/analysis.js';

const SR = 48000;
function loadMono(path, rate = SR) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const n = Math.floor(pcm.length / 4);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = dv.getFloat32(i * 4, true);
  return s;
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      const ur = re[i + k], ui = im[i + k];
      const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
      const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
      re[i + k] = ur + vr; im[i + k] = ui + vi;
      re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
    }
  }
}
function brickwall(x, cutoff, n = 4096) {
  const out = Float64Array.from(x);
  for (let s = 0; s + n <= out.length; s += n) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = out[s + i];
    fft(re, im);
    for (let k = 0; k < n; k++) { const f = k <= n / 2 ? k * SR / n : (n - k) * SR / n; if (f > cutoff) { re[k] = 0; im[k] = 0; } }
    fft(re, im);
    for (let i = 0; i < n; i++) out[s + i] = re[i] / n;
  }
  return out;
}

const src = loadMono('rec-test/zpev.wav');
function row(label, x) {
  const spec = ltas(x, SR, 4096, null, null);
  const f1 = fhe(spec, 2000, 3600);      // tenorské pásmo
  const f2 = fhe(spec, 2000, 3200);
  console.log(`${label.padEnd(12)} | FHE 2,0–3,6k ${String(Math.round(f1)).padStart(4)} Hz | FHE do 3,2k ${String(Math.round(f2)).padStart(4)} Hz | alpha ratio ${alphaRatio(spec).toFixed(2)} dB`);
}
row('plné pásmo', src);
for (const c of [4000, 3600, 3400, 3000, 2600]) row(`ořez ${c} Hz`, brickwall(src, c));
