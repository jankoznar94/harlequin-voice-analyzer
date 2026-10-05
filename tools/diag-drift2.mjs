/* Přímý rozbor: co vrátí countNotePlateaus na driftu nahoru-dolů. */
import { countNotePlateaus } from '/home/martin_fabian/vocal-lab-app/src/analysis.js';

const dt = 0.01;
function zKontury(dur, cc) {
  const n = Math.round(dur / dt);
  const times = new Float64Array(n), f0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = i * dt;
    const u = i / (n - 1);
    const c = cc * (u < 0.5 ? u * 2 : (1 - u) * 2);
    f0[i] = 146.83 * Math.pow(2, c / 1200);
  }
  return { times, f0 };
}
for (const cc of [400, 1000, 1328]) {
  const { times, f0 } = zKontury(5.0, cc);
  const pl = countNotePlateaus(times, f0, { minDur: 0.22 });
  console.log(`\n— kontura ±${cc / 2} c (celkem ${cc} c) —`);
  console.log(`   f0 vstup: min ${Math.min(...f0).toFixed(1)} max ${Math.max(...f0).toFixed(1)} Hz`);
  for (const p of pl) {
    console.log(`   úsek ${p.t0.toFixed(2)}–${p.t1.toFixed(2)} s  f0 ${p.f0.toFixed(1)} Hz  span ${Math.round(p.spanCents)} c  isGlide ${p.isGlide}`);
  }
}
// a teď s krokem, který překročí `stay` ale ne `enter`
console.log('\n— schodovitý drift po 60 c (překročí stay 50, ne enter 70) —');
{
  const n = Math.round(5.0 / dt);
  const times = new Float64Array(n), f0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = i * dt;
    const krok = Math.floor(i * dt / 0.3);
    f0[i] = 146.83 * Math.pow(2, (krok * 60) / 1200);
  }
  const pl = countNotePlateaus(times, f0, { minDur: 0.22 });
  for (const p of pl) console.log(`   úsek ${p.t0.toFixed(2)}–${p.t1.toFixed(2)} s f0 ${p.f0.toFixed(1)} Hz span ${Math.round(p.spanCents)} c`);
}
