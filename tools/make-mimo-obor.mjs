#!/usr/bin/env node
/* Vyrobí WAV, ve kterém je ÚSEK MIMO OBOR — aby se dala ověřit cesta
 * „vyřazený úsek → report/JSON" (na čistém zpěvu se ta větev netestuje).
 *
 * Obsah: tón 220 Hz · tón 110 Hz (A2, mimo tenor 123–660) · tón 196 Hz.
 */
import { writeFileSync } from 'node:fs';

const RATE = 48000;
function tone(f0, secs, amp = 0.22) {
  const n = Math.round(secs * RATE);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= 14; h++) { if (h * f0 > RATE / 2 - 200) break; v += (1 / h) * Math.sin(2 * Math.PI * h * f0 * i / RATE); }
    const fade = Math.min(1, i / 500) * Math.min(1, (n - i) / 500);
    out[i] = amp * v * fade;
  }
  return out;
}
const silence = (secs) => new Float64Array(Math.round(secs * RATE));

const parts = [silence(0.5), tone(220, 1.0), silence(0.4), tone(110, 1.6), silence(0.4), tone(196, 1.0), silence(0.3)];
const total = parts.reduce((s, p) => s + p.length, 0);
const sig = new Float64Array(total);
let o = 0;
for (const p of parts) { sig.set(p, o); o += p.length; }

// WAV 16bit mono
const data = Buffer.alloc(sig.length * 2);
for (let i = 0; i < sig.length; i++) {
  const v = Math.max(-1, Math.min(1, sig[i]));
  data.writeInt16LE(Math.round(v * 32767), i * 2);
}
const hdr = Buffer.alloc(44);
hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
hdr.writeUInt32LE(RATE, 24); hdr.writeUInt32LE(RATE * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
const out = process.argv[2] || 'rec-test/mimo-obor.wav';
writeFileSync(out, Buffer.concat([hdr, data]));
console.log(`zapsáno ${out} · ${(total / RATE).toFixed(1)} s`);
