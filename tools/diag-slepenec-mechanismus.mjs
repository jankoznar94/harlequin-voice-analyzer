/* Reprodukce skutečného slepence: YIN na slabém tónu PŘESKAKUJE mezi f0
 * a jeho násobkem tak rychle, že to segmentace (minChange 55 ms) nestihne
 * rozdělit a slije to do jednoho úseku.
 *
 * Ověřuje se přímo `countNotePlateaus`, protože tam vada vzniká. */
import { countNotePlateaus, medianFilter } from '/home/martin_fabian/vocal-lab-app/src/analysis.js';

const SR = 48000;
function voice(dur, kontura, f0base = 146.83, nharm = 60) {
  const n = Math.round(dur * SR), out = new Float64Array(n);
  const faze = new Float64Array(nharm + 1);
  for (let i = 0; i < n; i++) {
    const t = i / SR; const f0 = f0base * kontura(t);
    let v = 0;
    for (let h = 1; h <= nharm; h++) {
      const f = f0 * h; if (f >= SR / 2) break;
      faze[h] += 2 * Math.PI * f / SR;
      let a = 1 / h ** 1.1;
      a *= 1 + 5 / (1 + ((f - 600) / 900) ** 2);
      a *= 1 + 3 / (1 + ((f - 1300) / 1100) ** 2);
      v += a * Math.sin(faze[h]);
    }
    out[i] = 0.18 * v;
  }
  return out;
}

/** Postaví konturu s PRAVIDELNÝM přeskakováním f0 / 2·f0 po dobu `dur`. */
function prepinani(dur, perioda, dt = 0.01) {
  const n = Math.round(dur / dt), times = new Float64Array(n), cents = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = i * dt;
    const faze = (i * dt) % perioda;
    cents[i] = faze < perioda / 2 ? 0 : 1200;      // D3 ↔ D4
  }
  // yIN by vrátil f0 v Hz; převedeme zpět, protože countNotePlateaus bere Hz
  const f0 = new Float64Array(n);
  for (let i = 0; i < n; i++) f0[i] = 146.83 * Math.pow(2, cents[i] / 1200);
  return { times, f0: medianFilter(f0, 15) };
}

console.log('perioda přepínání | úseků | rozkmity (centy)');
for (const perioda of [0.03, 0.05, 0.08, 0.12, 0.2, 0.4, 0.8]) {
  const { times, f0 } = prepinani(5.0, perioda);
  const pl = countNotePlateaus(times, f0, { minDur: 0.22 });
  const spans = pl.map(p => Math.round(p.spanCents));
  console.log(`  ${String(perioda).padStart(6)} s        | ${String(pl.length).padStart(5)} | ${spans.join(', ')}`);
}
