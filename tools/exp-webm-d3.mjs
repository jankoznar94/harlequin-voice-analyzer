#!/usr/bin/env node
/* A/B: rozhodování brány pásma na tónu v NÍZKÉ poloze (D3) — bez znalosti
 * vzorkovacího kmitočtu vs. se znalostí.
 *
 * PROČ: uživatel nahrál tón D3 do aplikace a dostal
 *   „pásmo useknuto na ~3211 Hz (potřeba asfpoň 4100 Hz) — nahraj WAV"
 * — tedy hlášku o KOMPRESI u nahrávky, kterou si aplikace sama vyrobila.
 * Příčina byla v tom, že `sniffSampleRate` neuměl WebM/Opus, takže `fileRate`
 * bylo NaN → `knownRate = false` → místo poměrového testu `bandCut` se použila
 * přísná ABSOLUTNÍ mez pásma. U nízkého tónu leží vrchol spektra hluboko a
 * 40 dB pod ním skončí dřív, než se dojde k 4100 Hz.
 *
 * Skript staví tón s harmonickou řadou pod obálkou rezonancí hlasu (aby
 * v pásmu 2–4 kHz skutečně něco bylo, jako u zpěvu) a ukazuje obě rozhodnutí.
 */
import { sprValid, ltas, analyze } from '../src/analysis.js';
import { sniffSampleRate } from '../src/sample-rate.js';
import { writeFileSync } from 'node:fs';

const RATE = 48000;

/** Zpívaný tón: harmonická řada (1/h) pod obálkou F1–F3 + zpěvácký formant. */
function sung(f0, secs, rate = RATE, amp = 0.25) {
  const n = Math.round(secs * rate);
  const out = new Float64Array(n);
  // rezonance zhruba pro mužský hlas
  const form = [[500, 90, 1.0], [1500, 130, 0.55], [2600, 200, 0.35], [3200, 350, 0.30]];
  const gain = (f) => form.reduce((s, [c, bw, g]) => s + g * Math.exp(-((f - c) ** 2) / (2 * bw ** 2)), 0.05);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h * f0 < rate / 2 - 200; h++) {
      const f = h * f0;
      v += (1 / h) * gain(f) * Math.sin(2 * Math.PI * f * i / rate);
    }
    const fade = Math.min(1, i / (rate * 0.05)) * Math.min(1, (n - i) / (rate * 0.05));
    out[i] = amp * v * fade;
  }
  return out;
}

function wav(samples, rate = RATE) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

console.log('─'.repeat(76));
console.log('A/B brány pásma na tónech v nízké poloze (zpívaná harmonická řada)\n');
console.log('  tón      f0     | bez kmitočtu (NaN)          | se znalostí 48 kHz');
console.log('  ────────────────+-----------------------------+---------------------------');

for (const [note, f0] of [['D3', 146.83], ['E3', 164.81], ['C3', 130.81], ['G3', 196.00], ['D4', 293.66]]) {
  const sig = sung(f0, 2.5);
  // spektrum celého souboru, jako v analyze()
  const spec = ltas(sig, RATE, 4096, null, null);
  const bezR = sprValid(spec, 4100, { fileRate: NaN });
  const sR = sprValid(spec, 4100, { fileRate: RATE });
  const f = (r) => `${String(Math.round(r.limit)).padStart(5)} Hz ${r.valid ? 'PROJDE ' : 'ODMÍTNE'}`;
  console.log(`  ${note.padEnd(6)} ${f0.toFixed(1).padStart(6)}  | ${f(bezR).padEnd(27)} | ${f(sR)}`);
  if (!bezR.valid && bezR.reason.includes('useknuto')) {
    console.log(`           → bez kmitočtu: ${bezR.reason}`);
  }
  if (!sR.valid) console.log(`           → se znalostí: ${sR.reason}`);
}

console.log('\n── Totéž celou cestou přes `analyze()` (WAV soubor na disku) ──');
for (const [note, f0] of [['D3', 146.83], ['E3', 164.81]]) {
  const b = wav(sung(f0, 2.5));
  writeFileSync(`/tmp/d3-${note}.wav`, b);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const rate = sniffSampleRate(ab);
  const n = Math.floor((b.length - 44) / 2);
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(44 + i * 2) / 32768;
  const r = analyze(samples, RATE, { fach: 'tenor', fileRate: rate });
  console.log(`  ${note}: sniff ${rate} Hz · pásmo ${Math.round(r.band.limit)} Hz · valid=${r.band.valid} · tóny ${r.n_notes} · ${r.summary.spr_unusable ? 'SPR NELZE: ' + r.summary.reason : 'SPR ok: ' + r.summary.spr_median.toFixed(1) + ' dB'}`);
}

console.log('\n── A co WebM z aplikace (Opus) ──');
{
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const src = 'rec-test/rec-audio-64k.webm';
  try {
    const b = readFileSync(src);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    console.log(`  ${src}: sniff = ${sniffSampleRate(ab)} Hz (dřív NaN → přísná cesta)`);
  } catch { console.log('  (rec-test/rec-audio-64k.webm není)'); }
}
