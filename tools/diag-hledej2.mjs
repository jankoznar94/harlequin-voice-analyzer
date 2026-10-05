/* Hledá vstup, na kterém countNotePlateaus vyrobí úsek s rozkmitem > 700 c.
 * Zkouší se náhodné procházky s různými semínky (deterministicky). */
import { countNotePlateaus, medianFilter } from '/home/martin_fabian/vocal-lab-app/src/analysis.js';

const dt = 0.01;
function prochazka(seed, krokyZaSekundu, velikost, dur = 5.0) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
  const n = Math.round(dur / dt);
  const times = new Float64Array(n), f0 = new Float64Array(n);
  let c = 0;
  const krok = Math.max(1, Math.round(1 / (krokyZaSekundu * dt)));
  for (let i = 0; i < n; i++) {
    times[i] = i * dt;
    if (i % krok === 0) c += rnd() * velikost;
    f0[i] = 146.83 * Math.pow(2, c / 1200);
  }
  return { times, f0 };
}

let nalezeno = [];
for (let seed = 1; seed <= 40 && nalezeno.length < 3; seed++) {
  for (const rychlost of [2, 5, 10, 20]) {
    for (const vel of [10, 25, 50, 100]) {
      const { times, f0 } = prochazka(seed, rychlost, vel);
      for (const [popis, filtr] of [['median15', (v) => medianFilter(v, 15)], ['bez', (v) => v]]) {
        const pl = countNotePlateaus(times, filtr(f0), { minDur: 0.22 });
        const spans = pl.map(p => Math.round(p.spanCents));
        const max = spans.length ? Math.max(...spans) : 0;
        if (max > 700) {
          nalezeno.push({ seed, rychlost, vel, popis, useku: pl.length, max, spans: spans.slice(0, 6) });
        }
      }
    }
  }
}
console.log('nalezené slepence:', JSON.stringify(nalezeno, null, 1));
