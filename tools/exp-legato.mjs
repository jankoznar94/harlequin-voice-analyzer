import { pitchTrack, medianFilter, countNotePlateaus, hzToNote } from '../src/analysis.js';
const SR = 44100;
const H = (m) => 440 * Math.pow(2, (m - 69) / 12);

// legato stupnice: 8 not po 0,7 s, bez pauz
const n = Math.round(8 * 0.7 * SR);
const sig = new Float64Array(n);
const phase = new Float64Array(n + 1);
const midis = [60, 62, 64, 65, 67, 69, 71, 72];
for (let i = 0; i < n; i++) {
  const t = i / SR;
  const k = Math.min(7, Math.floor(t / 0.7));
  const f = H(midis[k]) * (1 + (40 / 1200) * Math.sin(2 * Math.PI * 5.5 * t));
  phase[i + 1] = phase[i] + 2 * Math.PI * f / SR;
  let v = 0;
  for (let h = 1; h <= 30; h++) { if (h * f > SR / 2) break; v += (1 / h) * Math.sin(h * phase[i]); }
  const tt = t - k * 0.7;
  const env = Math.min(1, tt / 0.05, (0.7 - tt) / 0.08);
  sig[i] = v * Math.max(0, env) * 0.25;
}

const { times, f0 } = pitchTrack(sig, SR);
const sm = medianFilter(f0, 15);
console.log('kontura (každý 5. rámec) — očekáváno 8 not po 0,7 s:');
for (let i = 0; i < f0.length; i += 5) {
  console.log(times[i].toFixed(2), sm[i] > 0 ? hzToNote(sm[i]).padEnd(4) + sm[i].toFixed(1).padStart(7) : '—');
}
for (const [enter, stay, minDur, mg] of [[70, 130, 0.2, 0.25], [70, 90, 0.2, 0.25], [100, 150, 0.2, 0.25], [120, 200, 0.2, 0.3], [150, 250, 0.25, 0.3], [90, 120, 0.15, 0.15], [200, 300, 0.25, 0.35]]) {
  const p = countNotePlateaus(times, sm, { enterCents: enter, stayCents: stay, minDur, mergeGap: mg });
  console.log(`enter ${String(enter).padStart(3)} stay ${String(stay).padStart(3)} minDur ${minDur} merge ${mg} → ${p.length} úseků: ${p.map(x => hzToNote(x.f0)).join(' ')}`);
}
