/**
 * Ground-truth test segmentace: vyrobíme stupnici o ZNÁMÉM počtu not
 * (s vibratem, portamentem, pauzami a doprovodem) a měříme, kolik not
 * najde stará segmentace a kolik hysterezní čítač.
 */
import { readFileSync } from 'node:fs';
import { pitchTrack, medianFilter, segmentNotes, countNotePlateaus } from '../src/analysis.js';

const SR = 44100;

/** Hlas: harmonická řada s formantovým filtrem, volitelně vibrato a portamento. */
function voice(segments, { nHarm = 30, vibratoHz = 5.5, vibratoCents = 40 } = {}) {
  const total = segments.reduce((s, x) => s + x.dur, 0);
  const n = Math.round(total * SR);
  const out = new Float64Array(n);
  const phase = new Float64Array(n + 1);
  let idx = 0;
  for (const seg of segments) {
    const cnt = Math.round(seg.dur * SR);
    for (let i = 0; i < cnt && idx < n; i++, idx++) {
      const t = i / SR;
      // portamento: první 15 % noty plynule dojede z předchozí výšky
      let f0 = seg.f0;
      if (seg.from && t < 0.15 * seg.dur) {
        const k = Math.log2(seg.from / seg.f0) * (1 - t / (0.15 * seg.dur));
        f0 = seg.f0 * Math.pow(2, k);
      }
      const vib = 1 + (vibratoCents / 1200) * Math.sin(2 * Math.PI * vibratoHz * t);
      const f = f0 * vib;
      phase[idx + 1] = phase[idx] + 2 * Math.PI * f / SR;
      let v = 0;
      for (let h = 1; h <= nHarm; h++) {
        const fh = h * f;
        if (fh > SR / 2) break;
        let a = 1 / h;
        // formantové špičky
        for (const [F, BW, g] of [[700, 90, 1.6], [1150, 110, 1.0], [2600, 140, 0.8], [2900, 200, 0.9]]) {
          a += g / (1 + ((fh - F) / BW) ** 2) * (1 / h) * 2;
        }
        v += a * Math.sin(h * phase[idx]);
      }
      // obálka: 5 % náběh, 8 % doznění
      const env = Math.min(1, t / (0.05 * seg.dur), (seg.dur - t) / (0.08 * seg.dur));
      out[idx] = v * Math.max(0, env) * 0.25;
    }
  }
  for (const x of segments) if (x.silenceAfter) idx += Math.round(x.silenceAfter * SR);
  return out;
}

/** Ticho jako samostatná pole — skládáme ručně. */
function buildSequence(segments, opts = {}) {
  const parts = [];
  for (const seg of segments) {
    parts.push(voice([seg], opts));
    if (seg.silenceAfter) parts.push(new Float64Array(Math.round(seg.silenceAfter * SR)));
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float64Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function run(name, sig, expected) {
  const { times, f0 } = pitchTrack(sig, SR);
  const sm = medianFilter(f0, 15);
  const old = segmentNotes(times, f0, { minDur: 0.3 });
  const hys = countNotePlateaus(times, sm, { enterCents: 70, stayCents: 130, minDur: 0.20 });
  const mark = (n) => (n === expected ? '✓' : '✗');
  console.log(`${name.padEnd(42)} očekáváno ${String(expected).padStart(3)} | stará ${mark(old.length)} ${String(old.length).padStart(3)} | hystereze ${mark(hys.length)} ${String(hys.length).padStart(3)}`);
  return { old: old.length, hys: hys.length, expected };
}

console.log('\n=== Segmentace: kolik not je na nahrávce ===\n');
const N = (n, dur, sil, extra = {}) => ({ f0: n, dur, silenceAfter: sil, ...extra });
const H = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// 1. osmitónová stupnice, každý tón 0,8 s, 0,25 s pauza
run('stupnice C dur, 8 not po 0,8 s',
  buildSequence([60, 62, 64, 65, 67, 69, 71, 72].map(m => N(H(m), 0.8, 0.25))), 8);

// 2. totéž, ale kratší tóny 0,4 s
run('stupnice C dur, 8 not po 0,4 s',
  buildSequence([60, 62, 64, 65, 67, 69, 71, 72].map(m => N(H(m), 0.4, 0.2))), 8);

// 3. vzestupná kadence bez pauz (legato)
run('legato: 8 not bez pauz',
  buildSequence([60, 62, 64, 65, 67, 69, 71, 72].map(m => N(H(m), 0.7, 0, { from: null }))), 8);

// 4. držené tóny: 3 tóny po 2,5 s
run('3 držené tóny po 2,5 s',
  buildSequence([N(H(57), 2.5, 0.6), N(H(60), 2.5, 0.6), N(H(64), 2.5, 0.6)]), 3);

// 5. skoky přes oktávu (zrádné pro YIN)
run('5 skoků vždy o oktávu',
  buildSequence([N(H(48), 0.8, 0.3), N(H(60), 0.8, 0.3), N(H(52), 0.8, 0.3), N(H(64), 0.8, 0.3), N(H(55), 0.8, 0.3)]), 5);

// 6. glissando přes 12 půltónů – má to být JEDEN tón na konci? (kontrolní past)
run('pomalé glissando (1 tón, 3 s)',
  buildSequence([{ f0: H(60), dur: 3.0, silenceAfter: 0.5, from: H(48) }]), 1);

// 7. rychlá pasáž: 16 not po 0,25 s
run('rychlá pasáž: 16 not po 0,25 s',
  buildSequence(Array.from({ length: 16 }, (_, i) => N(H(60 + (i % 8)), 0.25, 0.08))), 16);

// 8. s doprovodem (klavír pod hlasem) – jen kontrola, že to neexploduje
{
  const mel = buildSequence([N(H(60), 0.8, 0.25), N(H(64), 0.8, 0.25), N(H(67), 0.8, 0.25), N(H(72), 0.8, 0.25)]);
  const acc = new Float64Array(mel.length);
  for (let i = 0; i < acc.length; i++) {
    const t = i / SR;
    acc[i] = (Math.sin(2 * Math.PI * H(36) * t) + 0.6 * Math.sin(2 * Math.PI * H(43) * t)) * 0.06 * Math.exp(-((t % 1.05)) * 2);
  }
  for (let i = 0; i < mel.length; i++) mel[i] += acc[i];
  run('4 noty + klavírní doprovod', mel, 4);
}
