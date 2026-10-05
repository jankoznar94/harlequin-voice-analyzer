#!/usr/bin/env node
/**
 * Vyrobí WAV s NIŽŠÍM drženým tónem — pro ověření hlášky v reálném prohlížeči.
 *
 * Použití: node tools/make-nizky-ton.mjs vystup.wav [f0] [sekundy]
 * (f0: 98 = G2, 110 = A2, 123 = B2, 131 = C3)
 */
import { writeFileSync } from 'node:fs';

const SR = 48000;
const OUT = process.argv[2] || '/home/martin_fabian/.cache/va-nizky-ton.wav';
const F0 = Number(process.argv[3] || 110);
const DUR = Number(process.argv[4] || 4);

function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const A = [[700, 90, 1], [1200, 120, 0.55], [2600, 180, 0.35]];
function ampAt(f) { let a = 0; for (const [fc, bw, g] of A) a += g / (1 + Math.pow((f - fc) / bw, 2)); return a + 0.02; }

const n = Math.round(SR * DUR);
const x = new Float64Array(n);
const r = rng(7);
let ph = 0;
for (let i = 0; i < n; i++) {
  const inst = F0 * (1 + 0.02 * Math.sin(2 * Math.PI * 5.6 * i / SR));
  ph += 2 * Math.PI * inst / SR;
  let v = 0;
  for (let h = 1; h * inst < 5000; h++) v += ampAt(h * inst) * Math.sin(h * ph) / Math.sqrt(h);
  // náběh a dokmit 0,1 s, ať to není useknuté
  const env = Math.min(1, i / (0.1 * SR)) * Math.min(1, (n - i) / (0.1 * SR));
  x[i] = 0.24 * v * env + (r() - 0.5) * 3e-4;
}
let pk = 0; for (const v of x) pk = Math.max(pk, Math.abs(v));
const gain = Math.pow(10, -8 / 20) / pk;      // špička ≈ −8 dBFS (jako v Janově nálezu)

const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8, 'ascii');
buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * gain * 32767))), 44 + i * 2);
writeFileSync(OUT, buf);
console.log(`napsáno ${OUT}: ${DUR} s @ ${SR} Hz, f0 ${F0} Hz, špička ${(20 * Math.log10(gain * pk + 1e-12)).toFixed(1)} dBFS`);
