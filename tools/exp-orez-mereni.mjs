/* Co se stane s MĚŘENÍM TÓNŮ, když je pásmo useknuté?
 * Brick-wall ořez téhož zpěvu, pak analýza: výška, hlasitost, počet tónů. */
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
const t0 = Date.now();
const base = analyze(src, SR, { fileRate: 44100, fach: 'tenor' });
console.log(`referencni: ${base.notes.length} tonu, dropped ${base.n_dropped}, band ${Math.round(base.band.limit)} Hz, valid=${base.band.valid}, SPR median ${base.summary.spr_median?.toFixed(2)} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

const byStart = new Map(base.notes.map(n => [Math.round(n.t_start * 100), n]));
for (const cut of [3400, 3000]) {
  const x = brickwall(src, cut);
  const t1 = Date.now();
  const r = analyze(x, SR, { fileRate: 44100, fach: 'tenor' });
  const s = r.summary;
  const matched = r.notes.filter(n => { const b = byStart.get(Math.round(n.t_start * 100)); return b && Math.abs(b.f0 - n.f0) < 3; }).length;
  console.log(`\norez ${cut} Hz: band ${Math.round(r.band.limit)} Hz valid=${r.band.valid} (${r.band.reason})`);
  console.log(`   tonu ${r.notes.length} (ref ${base.notes.length}), shoda vysky do 3 Hz: ${matched}`);
  console.log(`   spr_unusable=${!!s.spr_unusable}, n_notes=${s.n_notes ?? '-'}, SPR median=${s.spr_median?.toFixed?.(2) ?? '-'}, peak ${r.peak_dbfs?.toFixed(1)} dBFS`);
  if (r.notes.length) {
    const sp = r.notes.map(n => n.spl_dbfs).filter(v => v === v).sort((a, b) => a - b);
    console.log(`   hlasitost tonu: median ${sp[sp.length >> 1].toFixed(1)} dBFS, rozsah ${sp[0].toFixed(1)} az ${sp[sp.length - 1].toFixed(1)}`);
  }
  console.log(`   (${((Date.now() - t1) / 1000).toFixed(1)} s)`);
}
