/**
 * Ověření, že se „vyrovnaně špatný" hlas pozná od „vyrovnaně dobrého".
 * Vyrovnanost sama nestačí — musí to zachytit ÚROVEŇ proti literatuře.
 */
import { analyze } from '../src/analysis.js';

const SR = 44100;
const H = (m) => 440 * Math.pow(2, (m - 69) / 12);

function tone(midi, dur, kind) {
  const n = Math.round(dur * SR);
  const out = new Float64Array(n);
  const ph = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = H(midi) * (1 + (40 / 1200) * Math.sin(2 * Math.PI * 5.5 * t));
    ph[i + 1] = ph[i] + 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h <= 40; h++) {
      const fh = h * f;
      if (fh > SR / 2) break;
      let a = 1 / h;
      for (const [F, BW, g] of [[700, 90, 1.6], [1150, 110, 1.0]]) a += g / (1 + ((fh - F) / BW) ** 2) * (1 / h) * 2;
      const ringGain = kind === 'ring' ? 1.4 : kind === 'mid' ? 0.5 : 0.02;
      a += ringGain / (1 + ((fh - 2850) / 220) ** 2) * (1 / h) * 2;
      v += a * Math.sin(h * ph[i]);
    }
    const e = Math.min(1, t / (0.05 * dur), (dur - t) / (0.08 * dur));
    out[i] = v * Math.max(0, e);
  }
  let mx = 0;
  for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] = out[i] / mx * 0.5;
  return out;
}
function build(spec) {
  const parts = [];
  for (const [midi, dur, kind] of spec) { parts.push(tone(midi, dur, kind)); parts.push(new Float64Array(Math.round(0.3 * SR))); }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const sig = new Float64Array(total);
  let off = 0;
  for (const p of parts) { sig.set(p, off); off += p.length; }
  return sig;
}

const sc = [
  ['všech 10 s ringem', 'ring', 10],
  ['všech 10 bez ringu', 'flat', 10],
  ['všech 10 napůl', 'mid', 10],
  ['9 s ringem + 1 bez', null, 10],
];
console.log('scénář                     vyrovnanost | výpadků | SPR medián | úroveň proti literatuře');
for (const [name, kind, n] of sc) {
  const spec = kind
    ? Array.from({ length: n }, (_, i) => [57 + i, 0.9, kind])
    : Array.from({ length: n }, (_, i) => [57 + i, 0.9, i === 5 ? 'flat' : 'ring']);
  const res = analyze(build(spec), SR, { fach: 'vse' });
  const s = res.summary;
  console.log(`${name.padEnd(26)} ${s.ring_consistency_pct.toFixed(1).padStart(9)} % | ${String(s.dropouts.length).padStart(7)} | ${s.spr_median.toFixed(2).padStart(10)} | ${s.level} (nad −20 dB: ${s.pct_above_ref.toFixed(0)} %)`);
}
console.log('\nPoznámka: „všech 10 bez ringu" MUSÍ mít vyrovnanost 100 % — ring tam sice chybí,');
console.log('ale chybí rovnoměrně. Rozdíl musí poznat až úroveň (pod_nezpevakem).');
