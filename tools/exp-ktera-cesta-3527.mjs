/* Která cesta dá mez ~3527 Hz (tj. přesně hlášku, kterou uživatel viděl)?
 * Zkouší se reálné soubory z aplikace s kmitočtem ZNÁMÝM i NEPOZNANÝM. */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { analyze } from '/home/martin_fabian/vocal-lab-app/src/analysis.js';
import { sniffSampleRate } from '/home/martin_fabian/vocal-lab-app/src/sample-rate.js';

const SR = 48000;
function loadMono(p, r = SR) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-ac', '1', '-ar', String(r), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const n = Math.floor(pcm.length / 4);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = dv.getFloat32(i * 4, true);
  return s;
}
const files = process.argv.slice(2);
console.log('soubor                     | sniff  | fileRate podán |  mez | raw  | bandCut | valid | tóny | výsledek');
for (const f of files) {
  const buf = readFileSync(f);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const sniff = sniffSampleRate(ab);
  const x = loadMono(f);
  for (const [label, fr] of [['známý', sniff], ['NEPOZNANÝ', NaN]]) {
    const r = analyze(x, SR, { fileRate: fr, fach: 'tenor' });
    const b = r.band;
    const out = r.summary.spr_unusable ? 'RING NELZE' : `SPR ${r.summary.spr_median.toFixed(1)} dB`;
    console.log(`${f.split('/').pop().padEnd(26)} | ${String(sniff).padStart(6)} | ${label.padEnd(14)} | ${String(Math.round(b.limit)).padStart(4)} | ${String(Math.round(b.limit_raw)).padStart(4)} | ${String(b.band_rel === undefined ? '—' : b.band_rel.toFixed(1)).padStart(7)} | ${String(b.valid).padEnd(5)} | ${String(r.notes.length).padStart(4)} | ${out}`);
  }
}
