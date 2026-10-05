#!/usr/bin/env node
/**
 * Otázka Jana: „Proč má jeden dlouhý tón (5 s) v grafu ringu JEDNU hodnotu
 *  a ne hodnotu přes celou dobu tónu, nebo X segmentů?“
 *
 * Změří, kolik tónů analyze() z 5s drženého tónu vyrobí, kde ten tón leží
 * v čase a jak moc se SPR uvnitř tónu hýbe (po 0,5s oknech).
 *
 * Použití: node tools/diag-jeden-ton.mjs [f0] [sekundy] [vibrato_pct]
 */
import { analyze, sprFrames, SPR_NFFT } from '../src/analysis.js';

const f0 = Number(process.argv[2] || 220);
const secs = Number(process.argv[3] || 5);
const vib = Number(process.argv[4] || 0);      // procenta
const SR = 48000;

/* Harmonická řada pod rezonanční obálkou (stejný postup jako v ostatních
 * experimentech) — FÁZE SE INTEGRUJE, jinak vznikne fázový skok a YIN v tom
 * výšku nenajde. */
function formantGain(f) {
  const F = [[700, 1.0, 110], [1220, 0.5, 130], [2600, 0.35, 190]];
  let g = 0;
  for (const [fc, a, bw] of F) g += a / (1 + ((f - fc) / bw) ** 2);
  return Math.max(0.03, g);
}
function tone(n, t0, f0, vib) {
  const out = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const f = f0 * (1 + (vib / 100) * Math.sin(2 * Math.PI * 5 * i / SR));
    ph += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h * f < 5200; h++) v += formantGain(h * f) * Math.sin(h * ph) / Math.sqrt(h);
    out[i] = 0.25 * v;
  }
  return out;
}

const N = Math.round(secs * SR);
const x = tone(N, 0, f0, vib);

console.log(`\n=== ${secs} s držený tón ${f0} Hz${vib ? `, vibrato ${vib} %` : ''} ===`);
const res = analyze(x, SR, { fach: 'tenor' });
const s = res.summary;
console.log(`nahrávka: ${s.duration?.toFixed(2)} s · pásmo ${s.band_limit_hz?.toFixed(0)} Hz`
  + ` · tónů ${s.n_notes} · vyřazeno ${s.n_dropped}`);
console.log(`SPR medián přes tóny: ${s.spr_median?.toFixed(2)} dB · nový ${s.spr_novy_median?.toFixed(2)} dB`
  + ` · ring ${s.ring_consistency_pct?.toFixed(0)} %`);
console.log('\ntóny, které analýza vyrobila:');
for (const n of res.notes) {
  console.log(`  #${n.idx}  ${n.t_start.toFixed(2)}–${n.t_end.toFixed(2)} s`
    + `  dur ${n.dur.toFixed(2)} s  f0 ${n.f0.toFixed(1)} Hz (${n.note})`
    + `  sd ${Number.isFinite(n.f0_sd_cents) ? n.f0_sd_cents.toFixed(0) : '—'} c`
    + `  SPR ${n.spr.toFixed(2)} / nový ${Number.isFinite(n.spr_novy) ? n.spr_novy.toFixed(2) : '—'} dB`
    + `  F1 ${Number.isFinite(n.f1) ? n.f1.toFixed(0) : '—'}`);
}
if (res.dropped?.length) {
  console.log('vyřazené úseky:');
  for (const d of res.dropped) console.log(`  ${d.t0.toFixed(2)}–${d.t1.toFixed(2)} s  ${d.why}`);
}

/* Jak moc se SPR hýbe UVNITŘ tónu — když se měří po 0,5s oknech. */
console.log('\nSPR po 0,5s oknech uvnitř tónu (tělo tónu, 20% z každé strany vynecháno):');
const a = Math.round(0.20 * N), b = Math.round(0.80 * N);
const win = Math.round(0.5 * SR);
const vals = [];
for (let s0 = a; s0 + win <= b; s0 += win) {
  const seg = x.subarray(s0, s0 + win);
  vals.push({ t: s0 / SR, spr: sprFrames(seg, SR), raw: sprFrames(seg, SR, { q: 0.5 }) });
}
const all = vals.map(v => v.spr);
console.log(`  hodnot ${all.length}: min ${Math.min(...all).toFixed(2)} · max ${Math.max(...all).toFixed(2)}`
  + ` · rozptyl ${(Math.max(...all) - Math.min(...all)).toFixed(2)} dB`);
for (const v of vals) console.log(`    ${v.t.toFixed(2)} s   p90 ${v.spr.toFixed(2)}   medián ${v.raw.toFixed(2)}`);

/* Kolik hodnot by graf mohl mít, kdyby se tón dělil na segmenty:
 * okno SPR_NFFT (85 ms) se posouvá po hopu SPR_NFFT/4 → 1 hodnota / 21 ms. */
const hop = Math.max(128, Math.round(SPR_NFFT / 4));
console.log(`\nKdyby se kreslily rámce místo tónů: krok ${(hop / SR * 1000).toFixed(0)} ms`
  + ` → ${Math.floor((b - a) / hop)} hodnot pro tento tón.`);
