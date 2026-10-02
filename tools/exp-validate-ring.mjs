/**
 * KRITICKÁ VALIDACE: umí nové vyhodnocení poznat SKUTEČNÝ výpadek ringu?
 *
 * Vyrobíme nahrávku, kde víme přesně, na kterých tónech ring chybí
 * (tóny bez pásma 2,5–3,2 kHz), a ověříme, že to metrika najde.
 * Kdyby hlásila 96 % i tady, vyměnili jsme jednu slepou chybu za druhou.
 */
import { analyze } from '../src/analysis.js';

const SR = 44100;
const H = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Tón se zadaným ringem: 'ring' = pásmo 2,5-3,2 kHz zesílené, 'flat' = potlačené. */
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
      // formanty hlasu
      for (const [F, BW, g] of [[700, 90, 1.6], [1150, 110, 1.0]]) {
        a += g / (1 + ((fh - F) / BW) ** 2) * (1 / h) * 2;
      }
      // zpěvácký formant: u 'ring' výrazný, u 'flat' potlačený
      const ringGain = kind === 'ring' ? 1.4 : 0.05;
      a += ringGain / (1 + ((fh - 2850) / 220) ** 2) * (1 / h) * 2;
      v += a * Math.sin(h * ph[i]);
    }
    const e = Math.min(1, t / (0.05 * dur), (dur - t) / (0.08 * dur));
    out[i] = v * Math.max(0, e);
  }
  // normalizuj podle maxima (aby hlasitost nebyla rozdílem)
  let mx = 0;
  for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] = out[i] / mx * 0.5;
  return out;
}

function build(spec) {
  const parts = [];
  for (const [midi, dur, kind] of spec) {
    parts.push(tone(midi, dur, kind));
    parts.push(new Float64Array(Math.round(0.3 * SR)));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const sig = new Float64Array(total);
  let off = 0;
  for (const p of parts) { sig.set(p, off); off += p.length; }
  return sig;
}

const scenarios = [
  ['všech 10 tónů s ringem', Array.from({ length: 10 }, (_, i) => [57 + i, 0.9, 'ring']), 0],
  ['10 tónů, 2 bez ringu', [...Array.from({ length: 10 }, (_, i) => [57 + i, 0.9, (i === 3 || i === 7) ? 'flat' : 'ring'])], 2],
  ['10 tónů, 5 bez ringu', [...Array.from({ length: 10 }, (_, i) => [57 + i, 0.9, i % 2 ? 'ring' : 'flat'])], 5],
  ['10 tónů, všech 10 bez ringu', Array.from({ length: 10 }, (_, i) => [57 + i, 0.9, 'flat']), 10],
];

console.log('=== Umí metrika najít SKUTEČNÝ výpadek ringu? ===\n');
console.log('scénář                        tónů | hlášeno s ringem | % | nalezených výpadků | správně');
for (const [name, spec, realDropouts] of scenarios) {
  const sig = build(spec);
  const res = analyze(sig, SR, { fach: 'vse' });
  const s = res.summary;
  if (s.spr_unusable) { console.log(`${name.padEnd(29)} — SPR nelze měřit`); continue; }
  const found = res.notes.filter(n => n.ring_dropout).length;
  const ok = found === realDropouts ? '✓' : `✗ (čekáno ${realDropouts})`;
  console.log(`${name.padEnd(29)} ${String(res.notes.length).padStart(4)} | ${String(s.notes_with_ring).padStart(16)} | ${s.ring_consistency_pct.toFixed(1).padStart(5)} | ${String(found).padStart(18)} | ${ok}`);
}

console.log('\n=== Detail: SPR po tónech (scénář 2 bez ringu ze 10) ===');
{
  const spec = Array.from({ length: 10 }, (_, i) => [57 + i, 0.9, (i === 3 || i === 7) ? 'flat' : 'ring']);
  const res = analyze(build(spec), SR, { fach: 'vse' });
  const s = res.summary;
  console.log(`medián ${s.spr_median.toFixed(2)} dB, práh ${s.ring_threshold.toFixed(2)} dB, MAD-výpadky: ${s.dropouts.length}`);
  res.notes.forEach(n => {
    console.log(`  ${n.note.padEnd(4)} SPR ${n.spr.toFixed(1).padStart(7)} dB  ${n.ring_ok ? 'vyrovnaný' : 'VÝPADEK'}${n.ring_above_ref ? '' : '  (pod literární mezí)'}`);
  });
}
