/**
 * Regresní testy měření PÁSMA nahrávky (regrese: „Ring nelze měřit — pásmo
 * useknuto" na nahrávce s plným pásmem).
 *
 * Reálná chyba, kterou to hlídá: `bandwidthLimit` měřil na SUROVÉM spektru a
 * ptát se „kde končí pásmo" přes vrchol. Když je ve snímku držený tón
 * doprovodu, je vrchol o desítky dB výš než obálka hlasu a všech 40 dB se
 * spotřebuje na cestu od něj dolů — nahrávka s plným pásmem pak vyjde jako
 * „useknutá na ~3855 Hz" a SPR se odmítne měřit. Naměřeno na témže souboru:
 * bez doprovodu mez 5215 Hz, s tónem 880 Hz na −18 dBFS mez 3855 Hz.
 *
 * Testuje se i to, že se test UMÍ ROZBIT: skutečně ořezaný zdroj (brick-wall
 * 3,4 kHz) musí zůstat odmítnutý. Kdyby obálka rozmazala i jeho, test spadne.
 */
import fs from 'node:fs';
import { ltas, sprValid, bandwidthLimit, spectralEnvelope } from '../src/analysis.js';

const SR = 48000;
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${info ? '  — ' + info : ''}`);
  ok ? pass++ : fail++;
};

/** Tón s harmonickou strukturou a formantovou obálkou = přibližuje zpěv.
 *  DŮLEŽITÉ: zdroj má SKLON (amplituda 1/h^1.5), takže vrchol spektra leží na
 *  základním tónu — přesně jako u skutečné nahrávky (naměřeno: vrchol na
 *  574 Hz, ne ve formantu). Bez toho by předloha nereprodukovala chybu, kvůli
 *  které tento test existuje: vrcholem se stane úzký tón doprovodu. */
function tone({ sr = SR, dur = 2.0, f0 = 392, formant = [2800, 3200, 20], nHarm = 120, amp = 0.2, tilt = 1.5 }) {
  const n = Math.round(sr * dur), out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr; let v = 0;
    for (let h = 1; h <= nHarm; h++) {
      const f = f0 * h; if (f >= sr / 2) break;
      let a = 1 / h ** tilt;
      if (formant) a *= 1 + 6 / (1 + ((f - formant[0]) / formant[1]) ** 2);
      v += a * Math.sin(2 * Math.PI * f * t);
    }
    out[i] = amp * v;
  }
  return out;
}

/** Držený doprovodný tón (klavír, smyčce) na dané úrovni v dBFS. */
function addTone(x, f, dbfs) {
  const y = Float64Array.from(x), a = 10 ** (dbfs / 20);
  for (let i = 0; i < y.length; i++) y[i] += a * Math.sin(2 * Math.PI * f * i / SR);
  return y;
}

/** Akord (klavírní doprovod) na danou úroveň. */
function addChord(x, dropDb) {
  const y = Float64Array.from(x);
  let pk = 0; for (const v of y) if (Math.abs(v) > pk) pk = Math.abs(v);
  const amp = pk * 10 ** (-dropDb / 20);
  const parts = [[220, 1], [277.2, 0.8], [329.6, 0.7], [440, 0.5], [554, 0.4], [659, 0.3]];
  for (let i = 0; i < y.length; i++) {
    const t = i / SR; let s = 0;
    for (const [f, w] of parts) s += w * Math.sin(2 * Math.PI * f * t);
    y[i] += amp * s / 3;
  }
  return y;
}

/** Věrná simulace useknutého pásma: brick-wall přes FFT. */
function brickwall(x, cutoff) {
  const n = 4096, out = Float64Array.from(x);
  for (let s = 0; s + n <= out.length; s += n) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = out[s + i];
    fft(re, im);
    for (let k = 0; k < n; k++) {
      const f = k <= n / 2 ? k * SR / n : (n - k) * SR / n;
      if (f > cutoff) { re[k] = 0; im[k] = 0; }
    }
    fft(re, im);
    for (let i = 0; i < n; i++) out[s + i] = re[i] / n;
  }
  return out;
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      const ur = re[i + k], ui = im[i + k];
      const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
      const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
      re[i + k] = ur + vr; im[i + k] = ui + vi;
      re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
    }
  }
}

console.log('\n═══ Pásmo nahrávky: doprovod nesmí vypadat jako ořez ═══');
{
  const voice = tone({});

  const r1 = sprValid(ltas(voice, SR));
  check('čistý zpěv → pásmo měřitelné', r1.valid, `mez ${Math.round(r1.limit)} Hz`);

  // DRŽENÝ DOPROVODNÝ TÓN na běžné úrovni — přesně to shazovalo měření
  for (const dbfs of [-26, -22, -18]) {
    const x = addTone(voice, 880, dbfs);
    const r = sprValid(ltas(x, SR));
    check(`zpěv + držený tón 880 Hz @ ${dbfs} dBFS → pásmo zůstává měřitelné`, r.valid,
      `mez ${Math.round(r.limit)} Hz (surové spektrum by dalo ${Math.round(r.limit_raw)})`);
  }

  // KLAVÍRNÍ AKORD 10 dB pod hlasem
  const ra = sprValid(ltas(addChord(voice, 10), SR));
  check('zpěv + akord 10 dB pod hlasem → pásmo měřitelné', ra.valid,
    `mez ${Math.round(ra.limit)} Hz`);

  // POJISTKA: skutečně useknutý zdroj se odmítnout MUSÍ
  for (const cut of [3400]) {
    const rb = sprValid(ltas(brickwall(voice, cut), SR));
    check(`zdroj useknutý na ${cut} Hz → správně odmítnuto`, !rb.valid,
      `mez ${Math.round(rb.limit)} Hz`);
  }
}

console.log('\n═══ Pásmo: obálka vs. surové spektrum (měření samo) ═══');
{
  /* ŘÍZENÉ SPEKTRUM — žádná syntéza audia. Sestaví se přesně situace, která
   * měření shazovala: obálka hlasu + ÚZKÝ držený tón o 25 dB výš.
   * Naměřeno na skutečné nahrávce: mez ze surového spektra 3855 Hz, z obálky
   * 5941 Hz. Tady model dává 3504 Hz vs. 4477 Hz — stejný mechanismus. */
  const binHz = 11.71875, n = 4096;
  const freq = new Float64Array(n), dbRaw = new Float64Array(n), dbEnv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = i * binHz;
    freq[i] = f;
    // obálka hlasu: vrchol ~600 Hz, nad ním −10 dB/oktávu, formantové maximum ~2,8 kHz
    let env = -20 - 10 * Math.log2(Math.max(1, f / 600));
    env += 7 * Math.exp(-((Math.log2(f / 2800)) ** 2) / 0.3);
    env -= 30 * Math.exp(-((Math.log2(Math.max(1, f / 220)) ** 2)) / 0.25);   // propad pod 200 Hz
    dbEnv[i] = env;
    dbRaw[i] = env;
  }
  for (let i = 0; i < n; i++) {                    // úzký tón 880 Hz, +25 dB nad obálkou hlasu
    const d = Math.abs(freq[i] - 880) / binHz;
    if (d < 6) dbRaw[i] = Math.max(dbRaw[i], dbEnv[i] + 25 - 6 * d * d);
  }
  const specRaw = { freq, db: dbRaw, binHz };
  const specEnvGiven = { freq, db: dbEnv, binHz };   // obálka bez špičky

  const raw = bandwidthLimit(specRaw);
  check('úzký tón v surovém spektru → měření ořezu SELŽE (doklad chyby)', raw < 4100,
    `surové spektrum hlásí mez ${Math.round(raw)} Hz`);
  check('obálka spektra pásmo udrží', bandwidthLimit(specEnvGiven) >= 4100,
    `obálka hlásí mez ${Math.round(bandwidthLimit(specEnvGiven))} Hz`);
  const r = sprValid(specRaw);
  check('sprValid na tom nezhroutí (bere širší z obou měření)', r.valid,
    `mez ${Math.round(r.limit)} Hz, surové ${Math.round(r.limit_raw)} Hz`);
  check('skutečný kód obálku opravdu počítá (ne jen test)', (() => {
    const e = spectralEnvelope(specRaw);
    const at = Math.round(880 / binHz);
    return dbRaw[at] - e.db[at] > 3;              // obálka špičku odstranila
  })());
}

console.log('\n═══ Pásmo: nesmí záviset na vzorkovacím kmitočtu nahrávky ═══');
{
  // Tentýž obsah při různém vzorkovacím kmitočtu musí dát stejný závěr.
  // Regrese: obálka s okny v BINECH (ne v Hz) ukousne pásmo na nízkém kmitočtu.
  const base = tone({ sr: 48000, dur: 2.0 });
  const dec = (sr) => {  // hrubá decimace = změna vzorkovacího kmitočtu
    const k = Math.round(48000 / sr), n = Math.floor(base.length / k);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = base[i * k];
    return { x: out, sr };
  };
  const verdicts = [];
  for (const sr of [16000, 22050, 32000, 44100]) {
    const { x } = dec(sr);
    const r = sprValid(ltas(x, sr));
    verdicts.push(r.valid);
    console.log(`     ${sr} Hz → mez ${Math.round(r.limit)} Hz, ${r.valid ? 'měřitelné' : 'VYLOUČENO'}`);
  }
  check('stejný závěr na 16 až 44,1 kHz', verdicts.every(v => v === verdicts[0]),
    verdicts.map(v => (v ? 'měřitelné' : 'VYLOUČENO')).join(' / '));
}

console.log('\n═══ Slepé místo: obálka sama nestačí, Math.max ano ═══');
{
  // Ověřuje se, že mez se bere z OBOU měření. Kdyby se brala jen obálka,
  // useknutý zdroj na nízkém kmitočtu by prošel (naměřeno: 5 kHz zdroj na
  // 16 kHz vzorkování dal obálkou 3914 Hz < 4100 — těsně pod prahem).
  const voice = tone({});
  const cut = brickwall(voice, 5000);
  const k = 3, n = Math.floor(cut.length / k);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = cut[i * k];      // ~16 kHz
  const spec = ltas(x, 16000);
  const raw = bandwidthLimit(spec), env = bandwidthLimit(spectralEnvelope(spec));
  console.log(`     zdroj 5 kHz @ 16 kHz: surové ${Math.round(raw)} Hz, obálka ${Math.round(env)} Hz`);
  check('mez se bere jako širší z obou měření', sprValid(spec).limit >= Math.max(raw, env) - 1e-6);
}

console.log(`\n═══ VÝSLEDEK: ${pass} prošlo, ${fail} selhalo ═══`);
process.exit(fail ? 1 : 0);
