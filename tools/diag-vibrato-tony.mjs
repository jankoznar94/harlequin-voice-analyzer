/* Proč vibrato dá 0 tónů? Rozbor kontury, kterou YIN vrátí. */
import { hzToNote, analyze, pitchTrack } from '../src/analysis.js';

const SR = 48000;
function voice(dur, kontura, f0base = 146.83) {
  const n = Math.round(dur * SR), out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f0 = f0base * kontura(t);
    let v = 0;
    for (let h = 1; h * f0 < SR / 2 && h <= 60; h++) {
      const f = f0 * h;
      let a = 1 / h ** 1.1;
      a *= 1 + 5 / (1 + ((f - 600) / 900) ** 2);
      a *= 1 + 3 / (1 + ((f - 1300) / 1100) ** 2);
      v += a * Math.sin(2 * Math.PI * f * t);
    }
    out[i] = 0.18 * v;
  }
  return out;
}
for (const [popis, kont] of [
  ['bez vibrata', () => 1.0],
  ['vibrato ±70c/5Hz', (t) => Math.pow(2, (70 / 1200) * Math.sin(2 * Math.PI * 5 * t))],
  ['vibrato ±40c/5Hz', (t) => Math.pow(2, (40 / 1200) * Math.sin(2 * Math.PI * 5 * t))],
  ['vibrato ±70c/6Hz měkčí', (t) => Math.pow(2, (70 / 1200) * Math.sin(2 * Math.PI * 6 * t))],
]) {
  const x = voice(4.0, kont);
  const { times, f0 } = pitchTrack(x, SR, {});
  const zname = Array.from(f0).filter(v => v > 0);
  const nuly = zname.length;
  const med = zname.length ? zname.sort((a, b) => a - b)[zname.length >> 1] : NaN;
  const r = analyze(x, SR, { fach: 'tenor' });
  console.log(`${popis.padEnd(24)} rámců s výškou ${String(nuly).padStart(5)}/${f0.length} · medián ${med.toFixed(1)} Hz (${med === med ? hzToNote(med) : '—'}) · tónů ${r.notes.length}`);
}
