/* Skutečný mechanismus slepence: PLYNULÝ DRIFT výšky.
 *
 * Segmentace uzná novou notu, jen když se nová výška UDRŽÍ aspoň `minChange`
 * (55 ms). Při plynulém driftu se ale za 55 ms výška posune jen o pár centů —
 * pod prahem `stay` (50 centů) — takže se úsek NIKDY nepřeruší a nabere
 * klidně přes oktávu. Naměřeno u uživatele: 1328 centů za 5,36 s, tedy
 * ~248 centů/s; za 55 ms to je 14 centů, hluboko pod prahem.
 *
 * Přesně to je „vytažený hrtan a málo opory" — výška pomalu leze a zpátky.
 */
import { countNotePlateaus, medianFilter } from '/home/martin_fabian/vocal-lab-app/src/analysis.js';

const SR = 48000;
function kontura(dur, celkemCentu, dt = 0.01) {
  const n = Math.round(dur / dt), times = new Float64Array(n), f0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = i * dt;
    const c = celkemCentu * (i / (n - 1));
    f0[i] = 146.83 * Math.pow(2, c / 1200);
  }
  return { times, f0: medianFilter(f0, 15) };
}
console.log('drift za 5 s | úseků | rozkmity (centy)');
for (const c of [100, 200, 400, 700, 1000, 1328, 1600]) {
  const { times, f0 } = kontura(5.0, c);
  const pl = countNotePlateaus(times, f0, { minDur: 0.22 });
  const spans = pl.map(p => Math.round(p.spanCents));
  console.log(`  ${String(c).padStart(5)} c     | ${String(pl.length).padStart(5)} | ${spans.join(', ')}`);
}
console.log('\nzpět nahoru a dolů (jak to reálný hlas dělá):');
for (const c of [400, 1000, 1328]) {
  const dt = 0.01, dur = 5.0, n = Math.round(dur / dt);
  const times = new Float64Array(n), f0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = i * dt;
    const u = i / (n - 1);
    const cc = c * (u < 0.5 ? u * 2 : (1 - u) * 2);
    f0[i] = 146.83 * Math.pow(2, cc / 1200);
  }
  const pl = countNotePlateaus(times, medianFilter(f0, 15), { minDur: 0.22 });
  console.log(`  ${String(c).padStart(5)} c     | ${String(pl.length).padStart(5)} | ${pl.map(p => Math.round(p.spanCents)).join(', ')}`);
}
