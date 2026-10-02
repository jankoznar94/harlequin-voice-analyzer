#!/usr/bin/env node
/**
 * Unit testy DSP jádra na syntetických signálech se ZNÁMOU pravdou.
 * Když tyhle neprojdou, nemá smysl porovnávat s Pythonem.
 */
import { fft, ltas, spr, fhe, alphaRatio, sprValid, pitchTrack, medianFilter,
  segmentNotes, hzToNote, lpcBurg, findFormants, formantsAt, vibrato, hnr,
  analyze } from '../src/analysis.js';

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) pass++; else fail++;
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? '  — ' + detail : ''}`);
}

function approx(a, b, tol, what) {
  const ok = Math.abs(a - b) <= tol;
  check(what, ok, `očekáváno ${b}, dostáno ${a.toFixed(3)} (tol ${tol})`);
  return ok;
}

const SR = 44100;

/** Harmonický tón s volitelným peakem (singer's formant). */
function tone(f0, seconds, { nHarm = 40, formant = null, amp = 0.5 } = {}) {
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 1; k <= nHarm; k++) {
      const f = k * f0;
      if (f > SR / 2) break;
      let a = 1 / k;
      if (formant && f >= formant[0] && f <= formant[1]) a *= formant[2];
      v += a * Math.sin(2 * Math.PI * f * i / SR);
    }
    out[i] = v * amp;
  }
  // normalizace
  let mx = 0;
  for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] /= mx;
  return out;
}

/** Tvrdý lowpass (brick-wall) přes FFT — věrná simulace useknutého pásma. */
function brickwall(x, cutoff) {
  const n = x.length;
  const N = 1 << Math.ceil(Math.log2(n));
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < n; i++) re[i] = x[i];
  fft(re, im);
  const binCut = Math.round(cutoff * N / SR);
  for (let i = binCut; i <= N - binCut; i++) { re[i] = 0; im[i] = 0; }
  fft(re, im);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = re[i] / N;
  return out;
}

/** Syntetický vokál: glotální pulzy buzené do rezonátorů (F1, F2, F3). */
function vowel(f0, seconds, formants, { amp = 0.5 } = {}) {
  const n = Math.round(seconds * SR);
  const period = SR / f0;
  const pulses = new Float64Array(n);
  for (let k = 0; k * period < n; k++) {
    const idx = Math.round(k * period);
    if (idx < n) pulses[idx] = 1;
  }
  // každý formant jako 2-pólový rezonátor (přímá forma II)
  let sum = new Float64Array(n);
  for (const [F, BW, gain] of formants) {
    const r = Math.exp(-Math.PI * BW / SR);
    const th = 2 * Math.PI * F / SR;
    const a1 = 2 * r * Math.cos(th), a2 = -r * r;
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const y = pulses[i] * (gain ?? 1) + a1 * y1 + a2 * y2;
      y2 = y1; y1 = y;
      sum[i] += y;
    }
  }
  let mx = 0;
  for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(sum[i]));
  for (let i = 0; i < n; i++) sum[i] = sum[i] / mx * amp;
  return sum;
}

console.log('\n═══ 1. FFT ═══');
{
  // čistý sinus 1000 Hz → jeden peak na 1000 Hz
  const N = 4096, n = N;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin(2 * Math.PI * 1000 * i / SR);
  fft(re, im);
  let best = 0, bi = 0;
  for (let i = 0; i < n / 2; i++) {
    const m = Math.hypot(re[i], im[i]);
    if (m > best) { best = m; bi = i; }
  }
  approx(bi * SR / n, 1000, SR / n, 'FFT najde peak 1000 Hz');
}

console.log('\n═══ 2. LTAS + SPR ═══');
{
  const noRing = tone(392, 2.0, { formant: null });
  const withRing = tone(392, 2.0, { formant: [2500, 3200, 25] });
  const sNo = spr(ltas(noRing, SR));
  const sYes = spr(ltas(withRing, SR));
  check('SPR rozliší tón s ringem od tónu bez', sYes > sNo + 8,
    `bez ringu ${sNo.toFixed(1)} dB, s ringem ${sYes.toFixed(1)} dB`);
  const hz = ltas(tone(440, 2.0), SR).binHz;
  approx(hz, SR / 4096, 0.01, 'frekvenční rozlišení LTAS');
}

console.log('\n═══ 3. FHE ═══');
{
  // tón s peakem vysoko → FHE výš
  const low = fhe(ltas(tone(392, 2.0, { formant: [2000, 2400, 20] }), SR));
  const high = fhe(ltas(tone(392, 2.0, { formant: [3000, 3500, 20] }), SR));
  check('FHE roste s polohou peaku', high > low,
    `nízko ${low.toFixed(0)} Hz, vysoko ${high.toFixed(0)} Hz`);
}

console.log('\n═══ 4. Detekce úseknutého pásma ═══');
{
  const full = tone(392, 2.0, { formant: [2800, 3200, 20] });
  const r1 = sprValid(ltas(full, SR));
  check('plné pásmo → SPR měřitelné', r1.valid, `mez ${r1.limit.toFixed(0)} Hz`);

  // věrná simulace telefonního pásma: tvrdý brick-wall lowpass na 3400 Hz
  const tel = brickwall(full, 3400);
  const r2 = sprValid(ltas(tel, SR));
  check('úseknuté pásmo → SPR odmítnuto', !r2.valid, r2.reason);

  // a kontrola: 5 kHz propust zůstane měřitelné
  const ok5k = brickwall(full, 5000);
  const r3 = sprValid(ltas(ok5k, SR));
  check('pásmo 5 kHz → stále měřitelné', r3.valid, `mez ${r3.limit.toFixed(0)} Hz`);
}

console.log('\n═══ 5. F0 (YIN) na známých frekvencích ═══');
{
  const cases = [110, 146.83, 196, 261.63, 392, 440, 523.25];
  for (const f of cases) {
    const sig = tone(f, 1.0, { nHarm: 30 });
    const { f0 } = pitchTrack(sig, SR);
    const v = Array.from(f0).filter(x => x > 0).sort((a, b) => a - b);
    const med = v.length ? v[v.length >> 1] : 0;
    const errCents = Math.abs(1200 * Math.log2(med / f));
    check(`f0 ${f} Hz`, errCents < 15, `naměřeno ${med.toFixed(2)} Hz (${errCents.toFixed(1)} centů)`);
  }
}

console.log('\n═══ 6. Segmentace ═══');
{
  // tři tóny za sebou s mezerami (mezi nimi ticho)
  const parts = [];
  for (const f of [261.63, 329.63, 392]) {
    parts.push(tone(f, 0.6, { nHarm: 30 }));
    parts.push(new Float64Array(Math.round(0.20 * SR)));  // mezera
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const sig = new Float64Array(total);
  let off = 0;
  for (const p of parts) { sig.set(p, off); off += p.length; }

  const { times, f0 } = pitchTrack(sig, SR);
  const segs = segmentNotes(times, f0, { minDur: 0.3 });
  check('najde 3 tóny', segs.length === 3, `nalezeno ${segs.length}`);

  const res = analyze(sig, SR, { fach: 'vse' });
  const notes = res.notes.map(n => n.note).join(',');
  check('správné noty (C4,E4,G4)', notes === 'C4,E4,G4', `nalezeno: "${notes}"`);
}

console.log('\n═══ 8. LPC formanty ═══');
{
  // syntetický vokál /a/: F1=730, F2=1090, F3=2600 (mužské /a/)
  const sig = vowel(220, 0.6, [[730, 90, 1.0], [1090, 110, 0.7], [2600, 140, 0.4]]);
  const i0 = Math.round(0.2 * SR), i1 = Math.round(0.5 * SR);
  const fs = formantsAt(sig, SR, i0, i1, { order: 20 });
  const found = fs.map(f => f.toFixed(0)).join(', ');
  const near = (t) => fs.some(f => Math.abs(f - t) < 0.15 * t);
  check('F1 ~730 Hz nalezen', near(730), `nalezeno: ${found} Hz`);
  check('F2 ~1090 Hz nalezen', fs.some(f => Math.abs(f - 1090) < 250), `nalezeno: ${found} Hz`);
}

console.log('\n═══ 9. Vibrato ═══');
{
  // 6 Hz vibrato, rozsah ±40 centů
  const n = Math.round(2.5 * SR);
  const sig = new Float64Array(n);
  const phase = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 392 * Math.pow(2, (40 / 1200) * Math.sin(2 * Math.PI * 6 * t));
    phase[i + 1] = phase[i] + 2 * Math.PI * f / SR;
    sig[i] = Math.sin(phase[i]) * 0.5;
  }
  const { f0 } = pitchTrack(sig, SR);
  const v = vibrato(medianFilter(f0, 3), 0.010);
  const cents = v.extent;
  check('najde vibrato ~6 Hz', Math.abs(v.rate - 6) < 1.0,
    `naměřeno ${v.rate.toFixed(2)} Hz`);
  check('rozsah vibrata ~80 centů (peak-to-peak)', Math.abs(cents - 80) < 45,
    `naměřeno ${cents.toFixed(0)} centů`);
}

console.log('\n═══ 7. Rozlišení dobrého a špatného tónu ═══');
{
  const good = analyze(tone(392, 1.5, { formant: [2500, 3200, 30] }), SR, { fach: 'vse' });
  const bad = analyze(tone(392, 1.5, { formant: null }), SR, { fach: 'vse' });
  const sg = good.summary.spr_median, sb = bad.summary.spr_median;
  check('engine rozliší ring', sg > sb + 8,
    `s ringem ${sg.toFixed(1)} dB vs bez ${sb.toFixed(1)} dB`);
}

console.log('\n═══ 8. LPC formanty ═══');
{
  // syntetický vokál /a/: F1=730, F2=1090, F3=2600 (mužské /a/)
  const sig = vowel(220, 0.6, [[730, 90, 1.0], [1090, 110, 0.7], [2600, 140, 0.4]]);
  const i0 = Math.round(0.2 * SR), i1 = Math.round(0.5 * SR);
  const fs = formantsAt(sig, SR, i0, i1);
  const found = fs.map(f => f.toFixed(0)).join(', ');
  const near = (t, tol = 0.12) => fs.some(f => Math.abs(f - t) < tol * t);
  check('F1 ~730 Hz nalezen', near(730), `nalezeno: ${found} Hz`);
  check('F2 ~1090 Hz nalezen', near(1090), `nalezeno: ${found} Hz`);
  check('F3 ~2600 Hz nalezen', near(2600), `nalezeno: ${found} Hz`);
}

console.log('\n═══ 9. Vibrato ═══');
{
  // 6 Hz vibrato, rozsah ±40 centů
  const n = Math.round(2.5 * SR);
  const sig = new Float64Array(n);
  const phase = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 392 * Math.pow(2, (40 / 1200) * Math.sin(2 * Math.PI * 6 * t));
    phase[i + 1] = phase[i] + 2 * Math.PI * f / SR;
    sig[i] = Math.sin(phase[i]) * 0.5;
  }
  const { f0 } = pitchTrack(sig, SR);
  const v = vibrato(medianFilter(f0, 3), 0.010);
  const cents = v.extent;
  check('najde vibrato ~6 Hz', Math.abs(v.rate - 6) < 1.0,
    `naměřeno ${v.rate.toFixed(2)} Hz`);
  check('rozsah vibrata ~80 centů (peak-to-peak)', Math.abs(cents - 80) < 45,
    `naměřeno ${cents.toFixed(0)} centů`);
}

console.log('\n═══ 10. Pásmo se měří JEDNOU za nahrávku (regrese) ═══');
{
  // Chyba, která se nesmí vrátit: když se šířka pásma měří po tónech,
  // výsledek sleduje tvar šumového dna daného úseku — čisté tóny propadnou
  // a zašuměné projdou. Přesně obráceně.
  const f0 = 220;
  const sig = tone(f0, 2.0, { formant: [2500, 3200, 20] });
  const res = analyze(sig, SR, { fach: 'vse' });
  check('analyze vrací band (pásmo nahrávky)', !!res.band && 'valid' in res.band,
    res.band ? `měřitelné=${res.band.valid}, mez=${Math.round(res.band.limit)} Hz` : 'chybí');
  check('plné pásmo → SPR měřitelné', res.band.valid === true);

  // useknuté pásmo → všechny tóny musí být označené jako neměřitelné
  const tel = brickwall(sig, 3400);
  const resTel = analyze(tel, SR, { fach: 'vse' });
  check('useknuté pásmo → band.valid = false', resTel.band.valid === false, resTel.band.reason);
  const anyMeasured = resTel.notes.some(n => n.spr_valid);
  check('useknuté pásmo → žádný tón nemá SPR', !anyMeasured,
    anyMeasured ? 'NĚKTERÉ TÓNY PROŠLY — chyba!' : '');
  check('useknuté pásmo → summary hlásí unusable',
    resTel.summary.spr_unusable === true);
}

console.log(`\n═══ VÝSLEDEK: ${pass} prošlo, ${fail} selhalo ═══`);
const failed = results.filter(r => !r.ok);
if (failed.length) {
  console.log('\nSelhalo:');
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
}
process.exitCode = fail ? 1 : 0;
