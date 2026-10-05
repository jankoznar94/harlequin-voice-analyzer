/* Ověřuje, že se slepenec z PLYNULÉHO DRIFTU (po mediánovém filtru) rozdělí.
 * Přesně tenhle vstup reprodukuje vadu uživatele: 1328 centů, jeden úsek. */
import { countNotePlateaus, medianFilter } from '/home/martin_fabian/vocal-lab-app/src/analysis.js';

const dt = 0.01;
function drift(dur, cc) {
  const n = Math.round(dur / dt);
  const times = new Float64Array(n), f0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = i * dt;
    const u = i / (n - 1);
    const c = cc * (u < 0.5 ? u * 2 : (1 - u) * 2);
    f0[i] = 146.83 * Math.pow(2, c / 1200);
  }
  return { times, f0: medianFilter(f0, 15) };
}
for (const cc of [1328, 1600, 2000]) {
  const { times, f0 } = drift(5.0, cc);
  const pl = countNotePlateaus(times, f0, { minDur: 0.22 });
  const spans = pl.map(p => Math.round(p.spanCents));
  console.log(`drift ±${cc / 2} c → ${pl.length} úseků, max span ${Math.max(...spans, 0)} c  [${spans.slice(0, 8).join(', ')}]`);
}
