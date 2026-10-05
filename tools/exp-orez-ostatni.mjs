/* Kolik z OSTATNÍCH metrik přežije useknuté pásmo?
 *
 * Otázka: když se ring změřit nedá, dá se aspoň tón/barva/ladění? Měří se
 * tytéž metriky na plném a na brick-wall ořezaném zpěvu (3,4 a 3,0 kHz).
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { analyze } from '/home/martin_fabian/vocal-lab-app/src/analysis.js';

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
const fach = 'tenor';
function line(label, r) {
  const s = r.summary;
  const f = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
  console.log(`${label.padEnd(14)} | pásmo ${String(Math.round(r.band.limit)).padStart(4)} | tóny ${String(r.notes.length).padStart(3)} | ` +
    `SPL med ${f(r.notes.map(n => n.spl_dbfs).sort((a, b) => a - b)[r.notes.length >> 1])} | ` +
    `FHE ${f(s.fhe_median, 0)} | VTL ${f(s.vtl_cm, 1)} cm (n=${s.vtl_n ?? 0}/${s.vtl_z_tonek ?? 0}) | ` +
    `HNR ${f(r.notes.map(n => n.hnr).filter(v => v === v).sort((a, b) => a - b)[r.notes.length >> 1])} | ` +
    `jitter ${f(r.notes.map(n => n.jitter_pct).filter(v => v === v).sort((a, b) => a - b)[r.notes.length >> 1], 2)} %`);
}
console.log('metrika        |        |           |            |       |        |                |     |');
line('plné pásmo', analyze(src, SR, { fileRate: 44100, fach }));
for (const cut of [3400, 3000, 2600]) line(`ořez ${cut} Hz`, analyze(brickwall(src, cut), SR, { fileRate: 44100, fach }));
