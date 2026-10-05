import { execFileSync } from 'node:child_process';
import { ltas, spr, sprFrames, percentile } from '/home/martin_fabian/vocal-lab-app/src/analysis.js';
const SR = 48000;
function loadMono(p, r = SR) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-ac', '1', '-ar', String(r), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
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
function bw(x, cut, n = 4096) {
  const out = Float64Array.from(x);
  for (let s = 0; s + n <= out.length; s += n) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = out[s + i];
    fft(re, im);
    for (let k = 0; k < n; k++) { const f = k <= n / 2 ? k * SR / n : (n - k) * SR / n; if (f > cut) { re[k] = 0; im[k] = 0; } }
    fft(re, im);
    for (let i = 0; i < n; i++) out[s + i] = re[i] / n;
  }
  return out;
}
const src = loadMono('rec-test/zpev.wav');
function row(l, x, rate = SR) {
  const spec = ltas(x, rate, 4096);
  const s = spr(spec);
  const fr = sprFrames(x, rate);
  console.log(`${l.padEnd(16)} SPR(ltas)=${s.toFixed(2)} dB  SPR(po ramcich p90)=${percentile(fr, 0.9).toFixed(2)} dB`);
}
row('plne pasmo', src);
for (const c of [4000, 3600, 3400, 3000]) row(`orez ${c} Hz`, bw(src, c));
const r16 = loadMono('rec-test/zpev.wav', 16000);
row('16 kHz (bez orezu)', r16, 16000);
