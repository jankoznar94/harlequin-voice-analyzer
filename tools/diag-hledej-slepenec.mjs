/* Hledá vstup, na kterém `countNotePlateaus` vyrobí úsek s rozkmitem přes
 * 700 centů (tedy slepenec). Testuje se PŘÍMO funkce — tam vada vzniká.
 *
 * Slepence vzniká KUMULACÍ při slévání (`p.spanCents = r.spanCents +
 * Math.abs(r.cents - p.cents)`), takže ho nevyrobí plynulý drift (ten se
 * rozdělí prahem `stay`), ale SCHODOVITÝ posun s malými kroky. */
import { countNotePlateaus, medianFilter } from '/home/martin_fabian/vocal-lab-app/src/analysis.js';

function bezMedFiltru(f0) { return f0; }
const dt = 0.01;
function kontura(schody) {
  const n = Math.round(5.0 / dt);
  const times = new Float64Array(n), f0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = i * dt;
    // schody: každý krok trvá `delka` s, krok je `krok` centů, s drobným chvěním
    const idx = Math.min(schody.length - 1, Math.floor(i * dt / 0.4));
    const c = schody[idx] + 8 * Math.sin(2 * Math.PI * 4 * i * dt);
    f0[i] = 146.83 * Math.pow(2, c / 1200);
  }
  return { times, f0 };
}

console.log('vzor | úseků | rozkmity');
const vzory = {
  'schody 30c × 40': Array.from({ length: 40 }, (_, i) => i * 30),
  'schody 50c × 30': Array.from({ length: 30 }, (_, i) => i * 50),
  'schody 25c × 60': Array.from({ length: 60 }, (_, i) => i * 25),
  'nahoru-dolů 25c': [...Array.from({ length: 30 }, (_, i) => i * 25), ...Array.from({ length: 30 }, (_, i) => (30 - i) * 25)],
  'nahoru-dolů 35c': [...Array.from({ length: 25 }, (_, i) => i * 35), ...Array.from({ length: 25 }, (_, i) => (25 - i) * 35)],
  'schody 20c × 70': Array.from({ length: 70 }, (_, i) => i * 20),
};
for (const [nazev, schody] of Object.entries(vzory)) {
  const { times, f0 } = kontura(schody);
  for (const [popis, filtr] of [['bez filtru', bezMedFiltru], ['median15', (v) => medianFilter(v, 15)]]) {
    const pl = countNotePlateaus(times, filtr(f0), { minDur: 0.22 });
    const spans = pl.map(p => Math.round(p.spanCents));
    const max = spans.length ? Math.max(...spans) : 0;
    console.log(`${nazev.padEnd(18)} ${popis.padEnd(10)} | ${String(pl.length).padStart(3)} | max ${String(max).padStart(5)} c`);
  }
}
