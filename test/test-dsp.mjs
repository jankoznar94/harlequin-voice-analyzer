#!/usr/bin/env node
/**
 * Unit testy DSP jádra na syntetických signálech se ZNÁMOU pravdou.
 * Když tyhle neprojdou, nemá smysl porovnávat s Pythonem.
 */
import { fft, ltas, spr, fhe, alphaRatio, sprValid, pitchTrack, medianFilter,
  segmentNotes, hzToNote, lpcBurg, findFormants, formantsAt, vibrato, hnr,
  analyze, countNotePlateaus, ringAnalysis } from '../src/analysis.js';

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

console.log('\n═══ 11. Segmentace not — ground truth (regrese) ═══');
{
  // REÁLNÁ CHYBA, která se nesmí vrátit: stará segmentace slévala legato
  // stupnici a rychlé pasáže do JEDNOHO tónu (8 not → 1, 16 not → 1) a na
  // skocích přes oktávu noty ztrácela (5 → 3). Počet tónů tím byl bez vztahu
  // k realitě. Nový čítač s ukotvenou notou to řeší — ověřeno na 9 případech.
  const SRl = 44100;
  const H = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function nota(midi, dur, gap) {
    const n = Math.round(dur * SRl);
    const out = new Float64Array(n);
    const ph = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const t = i / SRl;
      const f = H(midi) * (1 + (40 / 1200) * Math.sin(2 * Math.PI * 5.5 * t));
      ph[i + 1] = ph[i] + 2 * Math.PI * f / SRl;
      let v = 0;
      for (let h = 1; h <= 40; h++) {
        const fh = h * f;
        if (fh > SRl / 2) break;
        let a = 1 / h;
        for (const [F, BW, g] of [[700, 90, 1.6], [1150, 110, 1.0], [2600, 140, 0.8]]) {
          a += g / (1 + ((fh - F) / BW) ** 2) * (1 / h) * 2;
        }
        v += a * Math.sin(h * ph[i]);
      }
      const e = Math.min(1, t / (0.05 * dur), (dur - t) / (0.08 * dur));
      out[i] = v * Math.max(0, e) * 0.25;
    }
    return { out, gap };
  }
  function skladba(spec) {
    const parts = [];
    for (const [m, d, g] of spec) {
      const { out } = nota(m, d);
      parts.push(out);
      if (g) parts.push(new Float64Array(Math.round(g * SRl)));
    }
    const total = parts.reduce((s, p) => s + p.length, 0);
    const sig = new Float64Array(total);
    let off = 0;
    for (const p of parts) { sig.set(p, off); off += p.length; }
    return sig;
  }
  const pripady = [
    ['8 not po 0,8 s + pauzy', [[60, .8, .25], [62, .8, .25], [64, .8, .25], [65, .8, .25], [67, .8, .25], [69, .8, .25], [71, .8, .25], [72, .8, .25]], 8],
    ['8 not po 0,4 s', [[60, .4, .2], [62, .4, .2], [64, .4, .2], [65, .4, .2], [67, .4, .2], [69, .4, .2], [71, .4, .2], [72, .4, .2]], 8],
    ['8 not legato 0,7 s', [[60, .7, 0], [62, .7, 0], [64, .7, 0], [65, .7, 0], [67, .7, 0], [69, .7, 0], [71, .7, 0], [72, .7, 0]], 8],
    ['8 not legato 1,0 s', [[60, 1, 0], [62, 1, 0], [64, 1, 0], [65, 1, 0], [67, 1, 0], [69, 1, 0], [71, 1, 0], [72, 1, 0]], 8],
    ['12 not legato 0,35 s', Array.from({ length: 12 }, (_, i) => [57 + (i % 8), .35, 0]), 12],
    ['16 not po 0,25 s', Array.from({ length: 16 }, (_, i) => [60 + (i % 8), .25, .08]), 16],
    ['3 držené tóny 2,5 s', [[57, 2.5, .6], [60, 2.5, .6], [64, 2.5, .6]], 3],
    ['5 skoků přes oktávu', [[48, .8, .3], [60, .8, .3], [52, .8, .3], [64, .8, .3], [55, .8, .3]], 5],
    ['6 not sestupně legato', [[72, .6, 0], [69, .6, 0], [65, .6, 0], [62, .6, 0], [60, .6, 0], [57, .6, 0]], 6],
  ];
  for (const [nazev, spec, ocekavano] of pripady) {
    const sig = skladba(spec);
    const tr = pitchTrack(sig, SRl);
    const sm = medianFilter(tr.f0, 15);
    const p = countNotePlateaus(tr.times, sm, {});
    check(`segmentace: ${nazev}`, p.length === ocekavano,
      `očekáváno ${ocekavano}, nalezeno ${p.length}`);
  }
  // pomalý klouzavý přechod je JEDEN tón, ne dvanáct — mezera mezi skupinami
  const glide = new Float64Array(Math.round(3.0 * SRl));
  {
    const ph = new Float64Array(glide.length + 1);
    for (let i = 0; i < glide.length; i++) {
      const t = i / SRl;
      const f = H(48) * Math.pow(2, (12 / 12) * (t / 3.0));
      ph[i + 1] = ph[i] + 2 * Math.PI * f / SRl;
      let v = 0;
      for (let h = 1; h <= 30; h++) { if (h * f > SRl / 2) break; v += (1 / h) * Math.sin(h * ph[i]); }
      glide[i] = v * 0.25;
    }
  }
  const gt = pitchTrack(glide, SRl);
  const gp = countNotePlateaus(gt.times, medianFilter(gt.f0, 15), {});
  check('segmentace: klouzavý přechod = 1 tón', gp.length === 1, `nalezeno ${gp.length}`);
}

console.log('\n═══ 12. Vyhodnocení ringu (regrese) ═══');
{
  // REÁLNÁ CHYBA, která se nesmí vrátit: ring_ok se počítalo jako
  // spr >= max(vlastní práh, −20 dB). Medián SPR běžné nahrávky leží kolem
  // −19 dB, takže absolutní mez rozpůlila sadu a hlásila „~50 % tónů bez
  // ringu", i když byly všechny stejné. Navíc medián±MAD selže, když je bez
  // ringu asi polovina tónů — proto se dvouhroté rozdělení řeší mezerou.
  const mk = (sprs) => sprs.map((v, i) => ({
    idx: i, note: 'X', t_start: i, dur: 0.8, spl_dbfs: -12,
    spr: v, spr_valid: true, f1_tuning_relevant: false, f1_f0_err_pct: NaN,
    fhe: 2500, bandwidth_hz: 5000,
  }));
  // rovnoměrný hlas → žádný výpadek, i když je hladina nízká
  const a = ringAnalysis(mk([-25.1, -24.8, -25.4, -25.0, -24.9, -25.2, -25.3, -24.7, -25.5, -25.0]));
  check('rovnoměrná hladina → 0 výpadků', a.dropouts.length === 0,
    `${a.dropouts.length}, vyrovnanost ${a.ring_consistency_pct.toFixed(0)} %`);
  check('rovnoměrně nízká hladina → úroveň pod nezpěvákem', a.level === 'pod_nezpevakem',
    `${a.level} (medián ${a.spr_median.toFixed(1)} dB, mez nezpěváka −22,7)`);
  // jeden propadlý tón → musí se najít
  const b = ringAnalysis(mk([-15.2, -14.8, -15.5, -28.3, -15.1, -14.9, -15.3, -15.0, -14.7, -15.4]));
  check('jeden tón bez ringu → 1 výpadek', b.dropouts.length === 1,
    `${b.dropouts.length}, vyrovnanost ${b.ring_consistency_pct.toFixed(0)} %`);
  // POLOVINA tónů bez ringu — tady selhával medián±MAD, musí to najít mezera
  const c = ringAnalysis(mk([-14.8, -27.9, -15.1, -28.4, -14.9, -28.1, -15.3, -27.7, -15.0, -28.2]));
  check('polovina tónů bez ringu → najde 5 výpadků', c.dropouts.length === 5,
    `${c.dropouts.length}, metoda „${c.threshold_method}"`);
  check('polovina bez ringu → použita mezera, ne MAD', c.threshold_method === 'mezera mezi skupinami',
    c.threshold_method);
  // dobrý hlas → vysoká úroveň
  const d = ringAnalysis(mk([-12.1, -11.8, -12.4, -12.0, -11.9, -12.2, -12.3, -11.7, -12.5, -12.0]));
  check('dobrá hladina → úroveň profesionál', d.level === 'profesionalni', d.level);
  check('dobrá hladina → 0 výpadků', d.dropouts.length === 0, `${d.dropouts.length}`);
}

console.log('\n═══ 13. Krátké a tiché tóny se nehodnotí (regrese) ═══');
{
  // REÁLNÁ CHYBA, která se nesmí vrátit: na árii bez doprovodu vyšly jako
  // „výpadky ringu" čtyři útržky dlouhé 0,23–0,33 s s hlasitostí 25–39 dB pod
  // úrovní zpěvu. Ring na nich nemohl být měřitelný — nešlo o ztrátu ringu,
  // ale o nedostatek vzorku. Uživatel by hledal problém, který neexistuje.
  const mk2 = (spr, dur, spl) => ({
    idx: 0, note: 'X', t_start: 0, dur, spl_dbfs: spl,
    spr, spr_valid: true, f1_tuning_relevant: false, f1_f0_err_pct: NaN,
    fhe: 2500, bandwidth_hz: 5000,
  });
  // 8 zdravých tónů + 4 útržky (0,25 s a tiché) → útržky se vyřadí, žádný výpadek
  const zdrave = [14, 15, 13, 16, 15, 14, 15, 16].map(() => mk2(-15, 0.8, -13));
  const utrzky = [0, 1, 2, 3].map(() => mk2(-48, 0.25, -38));
  const r = ringAnalysis([...zdrave, ...utrzky]);
  check('útržky (krátké a tiché) → vyřazeny', r.n_notes === 8 && r.n_notes_excluded === 4,
    `použito ${r.n_notes}, vyřazeno ${r.n_notes_excluded} (krátké ${r.n_excluded_short}, tiché ${r.n_excluded_quiet})`);
  check('útržky → žádný falešný výpadek', r.dropouts.length === 0,
    `${r.dropouts.length} výpadků, vyrovnanost ${r.ring_consistency_pct.toFixed(0)} %`);

  // Propadlý tón, který JE dost dlouhý a hlasitý, se musí najít jako výpadek —
  // kdyby ho filtr vyřadil, zakryl by skutečný problém (a to je horší chyba
  // než falešný poplach).
  const kratkyHlasity = [mk2(-15, 1.2, -13), mk2(-15, 1.2, -13), mk2(-15, 1.2, -13),
    mk2(-15, 1.2, -13), mk2(-15, 1.2, -13), mk2(-15, 1.2, -13),
    mk2(-30, 0.5, -10)];   // dost dlouhý i hlasitý → zůstává a je výpadek
  const r2 = ringAnalysis(kratkyHlasity, { minDur: 0.30 });
  check('propadlý tón (dlouhý a hlasitý) → zůstává a je výpadek',
    r2.n_notes === 7 && r2.dropouts.length === 1,
    `použito ${r2.n_notes}, výpadků ${r2.dropouts.length}`);

  // KRÁTKÝ propadlý tón se naopak vyřadí — u něj SPR nic neznamená
  const kratkyPropadly = [mk2(-15, 1.2, -13), mk2(-15, 1.2, -13), mk2(-15, 1.2, -13),
    mk2(-15, 1.2, -13), mk2(-15, 1.2, -13), mk2(-15, 1.2, -13),
    mk2(-45, 0.22, -10)];
  const r2b = ringAnalysis(kratkyPropadly, { minDur: 0.30 });
  check('krátký propadlý tón → vyřazen, ne hlášen jako výpadek',
    r2b.n_notes === 6 && r2b.dropouts.length === 0,
    `použito ${r2b.n_notes}, vyřazeno ${r2b.n_notes_excluded}`);

  // POJISTKA: když by filtr ukrojil většinu, nesmí se použít (zahodil by důkazy)
  const vetsinaTicha = [14, 15, 13, 16].map(() => mk2(-15.5, 0.8, -13))
    .concat([0, 1, 2, 3, 4, 5].map(() => mk2(-30, 0.8, -40)));
  const r3 = ringAnalysis(vetsinaTicha);
  check('filtr by ukrojil většinu → nepoužije se', r3.filter_applied === false,
    `filter_applied=${r3.filter_applied}, použito ${r3.n_notes}`);
  check('pojistka → výpadky se přesto najdou', r3.dropouts.length === 6,
    `${r3.dropouts.length} výpadků`);

  // a naopak: když je tichých menšina, vyřadí se a falešný výpadek nevznikne
  const mensinaTicha = [14, 15, 13, 16, 15, 14, 15, 16, 15, 14].map(() => mk2(-15, 0.8, -13))
    .concat([0, 1].map(() => mk2(-48, 0.25, -38)));
  const r4 = ringAnalysis(mensinaTicha);
  check('tichá menšina → vyřazena, 0 falešných výpadků',
    r4.filter_applied === true && r4.dropouts.length === 0,
    `vyřazeno ${r4.n_notes_excluded}, výpadků ${r4.dropouts.length}`);
}

console.log('\n═══ 14. Ring nelze změřit: správně pojmenovaná příčina (regrese) ═══');
{
  // REÁLNÁ CHYBA, která se dostala k uživateli: hláška vždy tvrdila „nemá
  // dostatečné pásmo pro 2–4 kHz, nahraj WAV" — i když analýza nenašla ANI
  // JEDEN TÓN (ticho). Uživatel pak hledal vadu ve formátu, která tam není.
  // Analýza proto musí hlásit ŠPIČKU nahrávky, aby UI umělo ticho odlišit.
  const sr = 44100, dur = 12;
  const ticho = new Float64Array(sr * dur);                       // dokonalé ticho
  const rTicho = analyze(ticho, sr, { fach: 'tenor' });
  check('ticho → 0 tónů a spr_unusable', rTicho.notes.length === 0 && rTicho.summary.spr_unusable === true,
    `tónů ${rTicho.notes.length}, unusable ${!!rTicho.summary.spr_unusable}`);
  check('ticho → analysis vrací peak_dbfs', rTicho.peak_dbfs === rTicho.peak_dbfs,
    `peak_dbfs=${rTicho.peak_dbfs}`);
  check('ticho → špička je hluboko pod −30 dBFS', rTicho.peak_dbfs < -30,
    `${rTicho.peak_dbfs.toFixed(1)} dBFS`);

  // a naopak: tón, který tam JE, musí dát platnou špičku i tóny
  const s = new Float64Array(sr * dur);
  for (let i = 0; i < s.length; i++) {
    const t = i / sr;
    s[i] = 0.4 * Math.sin(2 * Math.PI * 220 * t) +
      0.12 * Math.sin(2 * Math.PI * 440 * t) + 0.08 * Math.sin(2 * Math.PI * 880 * t) +
      0.05 * Math.sin(2 * Math.PI * 2640 * t) + 0.04 * Math.sin(2 * Math.PI * 3520 * t);
  }
  const rTon = analyze(s, sr, { fach: 'tenor' });
  check('zpívaný tón → nenulová špička', rTon.peak_dbfs > -20 && rTon.peak_dbfs < 0,
    `${rTon.peak_dbfs.toFixed(1)} dBFS`);
  check('zpívaný tón → tóny nalezeny', rTon.notes.length > 0,
    `${rTon.notes.length} tónů`);

  // rozlišení: ticho vs tón se musí lišit aspoň o 30 dB
  check('ticho a tón se liší aspoň o 30 dB', rTon.peak_dbfs - rTicho.peak_dbfs > 30,
    `${(rTon.peak_dbfs - rTicho.peak_dbfs).toFixed(1)} dB`);
}

console.log('\n═══ 15. Nízký vzorkovací kmitočet nahrávky (regrese) ═══');
{
  /* REÁLNÁ CHYBA (naměřeno, opraveno): dekódování přes OfflineAudioContext
   * vrátí VŽDY 48 kHz, i když soubor měl 16 kHz. Analýza tedy nemohla poznat,
   * že pásmo 2–4 kHz je useknuté nízkým kmitočtem NAHRÁVKY, a hláška
   * „Ring nelze měřit — nízký vzorkovací kmitočet" se NIKDY nespustila
   * (podmínka `band.limit > 0,75·(sr/2)` se sr = 48000 nemůže vyjít).
   * Propadlo se vždy na radu „nahraj WAV", která u záznamníku na 16 kHz
   * nemůže pomoct. Test hlídá, že se kmitočet souboru předává DÁL.
   */
  const sr = 44100, dur = 12;
  const x = new Float64Array(sr * dur);
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    x[i] = 0.4 * Math.sin(2 * Math.PI * 220 * t) +
      0.12 * Math.sin(2 * Math.PI * 440 * t) + 0.08 * Math.sin(2 * Math.PI * 880 * t) +
      0.05 * Math.sin(2 * Math.PI * 2640 * t) + 0.04 * Math.sin(2 * Math.PI * 3520 * t);
  }

  // soubor z 8kHz záznamníku: Nyquist 4 kHz → ring měřit nelze a MUSÍ to říct
  const r8 = analyze(x, sr, { fach: 'tenor', fileRate: 8000 });
  check('8 kHz soubor → spr_unusable', r8.summary.spr_unusable === true,
    `unusable ${!!r8.summary.spr_unusable}`);
  check('8 kHz soubor → příčina je označená jako nízký kmitočet',
    r8.summary.low_rate === true, `low_rate=${r8.summary.low_rate}`);
  check('8 kHz soubor → v summary je PŮVODNÍ kmitočet, ne dekódovaný',
    r8.summary.file_rate === 8000, `file_rate=${r8.summary.file_rate}`);
  check('8 kHz soubor → hláška pojmenuje kmitočet, ne kompresi',
    /vzorkovací kmitočet/.test(r8.band.reason) && !/kompres/.test(r8.band.reason),
    `reason="${r8.band.reason}"`);

  // 16 kHz: Nyquist 8 kHz → pásmo 2–4 kHz JE měřitelné (naměřeno SPR do 2 dB)
  const r16 = analyze(x, sr, { fach: 'tenor', fileRate: 16000 });
  check('16 kHz soubor → ring měřit LZE (naivní mez by ho vyřadila)',
    r16.summary.spr_unusable !== true,
    `unusable ${!!r16.summary.spr_unusable}, mez ${Math.round(r16.band.limit)} Hz`);

  // 48 kHz: beze změny
  const r48 = analyze(x, sr, { fach: 'tenor', fileRate: 48000 });
  check('48 kHz soubor → ring měřit lze', r48.summary.spr_unusable !== true,
    `unusable ${!!r48.summary.spr_unusable}`);

  // neznámý kmitočet (nepoznaná hlavička) → stará přísná cesta, nikdy nepustí ořez
  const rNaN = analyze(x, sr, { fach: 'tenor' });
  check('bez znalosti kmitočtu se chová jako dřív (nic se nerozbije)',
    typeof rNaN.summary.spr_unusable === 'boolean',
    `unusable ${!!rNaN.summary.spr_unusable}`);
}

console.log(`\n═══ VÝSLEDEK: ${pass} prošlo, ${fail} selhalo ═══`);
const failed = results.filter(r => !r.ok);
if (failed.length) {
  console.log('\nSelhalo:');
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
}
process.exitCode = fail ? 1 : 0;
