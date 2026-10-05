/* Kolik z pásma ringu musí zbýt, aby SPR ještě platilo?
 *
 * SPR = peak(2–4 kHz) − peak(0–2 kHz). Když je nahrávka useknutá, chybí
 * horní část pásma — a to bolí tím víc, čím výš leží vrchol ringu.
 * Měří se: syntetický zpívaný tón se špičkou ringu na 2,8 kHz (typický tenor)
 * a na 3,5 kHz (vysoký ring), a k tomu ořez na 4,0 / 3,6 / 3,4 / 3,0 / 2,6 kHz.
 */
import { ltas, spr, sprInterp } from '/home/martin_fabian/vocal-lab-app/src/analysis.js';

const SR = 48000;
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
/** Zpívaný tón: harmonická řada se sklonem, formanty F1/F2 a špičkou ringu. */
function voice({ f0 = 233, dur = 3, ringHz = 2800, ringGain = 5, ringWidth = 900 }) {
  const n = Math.round(SR * dur), out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR; let v = 0;
    for (let h = 1; h * f0 < SR / 2; h++) {
      const f = f0 * h;
      let a = 1 / h ** 0.9;
      a *= 1 + 5 / (1 + ((f - 600) / 900) ** 2);          // F1
      a *= 1 + 3 / (1 + ((f - 1300) / 1100) ** 2);        // F2
      a *= 1 + ringGain / (1 + ((f - ringHz) / ringWidth) ** 2); // ring
      v += a * Math.sin(2 * Math.PI * f * t);
    }
    out[i] = 0.2 * v;
  }
  return out;
}
console.log('vrchol ringu |   plné  | 4,0 kHz | 3,6 kHz | 3,4 kHz | 3,0 kHz | 2,6 kHz');
console.log('-------------+---------+---------+---------+---------+---------+--------');
for (const ringHz of [2500, 2800, 3100, 3500, 3800]) {
  const x = voice({ ringHz, f0: 233 });
  const vals = [Infinity, 4000, 3600, 3400, 3000, 2600].map(c => {
    const y = c === Infinity ? x : brickwall(x, c);
    return spr(ltas(y, SR, 4096));
  });
  console.log(`${String(ringHz).padStart(9)} Hz | ` + vals.map(v => `${v.toFixed(1)}`.padStart(6) + ' dB').join(' |').replace(/ dB \|$/, ' dB'));
}
