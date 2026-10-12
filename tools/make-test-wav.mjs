/**
 * Vyrobí testovací WAV PŘES `src/wav.js` (tedy přesně tím kódem, kterým ho
 * ukládá aplikace), aby se dal ověřit v prohlížeči: soubor, který aplikace
 * vyrobí, musí aplikace umět i PŘEČÍST.
 *
 * Signál: čtyři držené tóny (C3, E3, G3, C4) s harmonickou řadou, pásmem
 * 2–4 kHz nahoře (aby vyšel SPR/ring) a krátkými pauzami.
 *
 * Použití: node tools/make-test-wav.mjs <out.wav>
 */
import { writeFileSync } from 'node:fs';
import { encodeWav } from '../src/wav.js';

const OUT = process.argv[2] || 'test-wav.wav';
const SR = 48000;
const TONES = [[130.81, 1.2], [164.81, 1.0], [196.00, 1.3], [261.63, 1.2]];
const total = TONES.reduce((a, t) => a + t[1] + 0.35, 0) + 0.5;
const buf = new Float64Array(Math.ceil(total * SR));

let pos = 0.25 * SR;
for (const [f0, durS] of TONES) {
  const N = Math.round(durS * SR);
  const fade = Math.round(0.03 * SR);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let v = 0;
    // harmonická řada se sklonem; vrchní harmonické drží pásmo 2–4 kHz
    for (let h = 1; h <= 30; h++) {
      const f = f0 * h;
      if (f > 8000) break;
      let a = Math.pow(h, -0.9);
      if (f > 2000 && f < 4500) a *= 3.2;              // „ring“: energie 2–4 kHz
      v += a * Math.sin(2 * Math.PI * f * t + h * 0.7);
    }
    v /= 6;
    // náběh/doběh, ať to není lupnutí
    const env = Math.min(1, i / fade, (N - i) / fade);
    buf[pos + i] = 0.35 * v * env;
  }
  pos += Math.round((durS + 0.35) * SR);
}

const wav = encodeWav(buf, SR);
writeFileSync(OUT, wav);
console.log(`${OUT}: ${(wav.length / 1024).toFixed(0)} kB, ${total.toFixed(1)} s, ${SR} Hz`);
