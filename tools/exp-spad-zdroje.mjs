#!/usr/bin/env node
/**
 * EXPERIMENT 2: dá se spád ZDROJE (addukce) změřit tak, aby ho NEROZHODILA
 * samohláska? A dá se z formantů číst délka traktu (poloha hrtanu)?
 *
 * PROČ: předchozí experiment (exp-formanty-hlas.mjs) naměřil, že H1–H2 má
 * mezi samohláskami rozptyl až **25 dB**, i když se „addukce" vůbec nezměnila.
 * To je přesně kritika z literatury (Simpson 2012, Kreiman 2012): H1–H2 měří
 * hlavně to, jak blízko leží H1 a H2 k F1, ne stav hlasivek.
 *
 * Tady se zkouší, jestli to spraví ODEČTENÍ OBÁLKY: z každé harmonické se
 * odečte rezonanční obálka traktu a ze zbytků se změří spád zdroje. Když to
 * funguje, rozptyl mezi samohláskami musí zmizet a citlivost na zdroj zůstat.
 *
 * Použití: node tools/exp-spad-zdroje.mjs
 */
import { ltas, spectralEnvelope } from '../src/analysis.js';

const mean = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
const sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); };
const fmt = (v, d = 2) => (v === v && v !== null && v !== undefined ? v.toFixed(d) : '—');
const SR = 48000;

function traktGain(f, F = [500, 1500, 2500], sirky = [120, 180, 220]) {
  const res = (fc, bw, a) => a / (1 + ((f - fc) / bw) ** 2);
  return res(F[0], sirky[0], 1.0) + res(F[1], sirky[1], 0.45)
       + res(F[2], sirky[2], 0.30) + res(3000, 250, 0.22) + res(3500, 300, 0.10);
}

function ton(f0, sekund = 1.6, { zdrojSpad = 1.0, F = [500, 1500, 2500], vibProc = 0 } = {}) {
  const n = Math.round(sekund * SR);
  const out = new Float64Array(n);
  let fi = 0;
  for (let i = 0; i < n; i++) {
    const f = f0 * (1 + vibProc * Math.sin(2 * Math.PI * 5.5 * i / SR));
    fi += 2 * Math.PI * f / SR;
    let s = 0;
    for (let h = 1; h * f0 < 6000; h++) s += (traktGain(h * f0, F) / h ** zdrojSpad) * Math.sin(h * fi);
    const fade = Math.min(1, i / 1200) * Math.min(1, (n - i) / 1200);
    out[i] = 0.25 * s * fade;
  }
  return out;
}

/** Úrovně harmonických (parabolická interpolace vrcholu). */
function harmonicke(spec, f0, doHz = 5000) {
  const { freq, db } = spec;
  const out = [];
  for (let h = 1; h * f0 < doHz; h++) {
    const f = h * f0;
    if (f < spec.binHz * 2) continue;
    const lo = Math.max(1, Math.round((f - 0.35 * f0) / spec.binHz));
    const hi = Math.min(freq.length - 2, Math.round((f + 0.35 * f0) / spec.binHz));
    let bi = -1, bv = -Infinity;
    for (let i = lo; i <= hi; i++) if (db[i] > bv) { bv = db[i]; bi = i; }
    if (bi <= 0 || bv === -Infinity) continue;
    const y0 = db[bi - 1], y1 = db[bi], y2 = db[bi + 1];
    const den = y0 - 2 * y1 + y2;
    const d = den ? 0.5 * (y0 - y2) / den : 0;
    out.push({ h, f, db: y1 - 0.25 * (y0 - y2) * d, peakDb: bv, idx: bi });
  }
  return out;
}

/**
 * SPÁD ZDROJE s odečtenou obálkou.
 *
 * Myšlenka: naměřená úroveň harmonické = obálka traktu(f) × zdroj(f).
 * Když od obálky odečtu hodnotu v místě harmonické, dostanu „excitační zbytek"
 * — tedy to, co dodal hlasivkový zdroj. Ze zbytků prvních N harmonických
 * udělám lineární regresi proti log2(h): sklon = spád zdroje v dB/oktávu.
 *
 * Obalík se bere z SPEKTRÁLNÍ OBÁLKY (`spectralEnvelope`), ne z LPC — je
 * hladká, nezávislá na odhadu řádu a neposouvá se s f0.
 *
 * POZOR: `spectralEnvelope` vrací OBJEKT `{freq, db, binHz}`, ne pole —
 * `env[i]` je `undefined` a celý výsledek vyjde NaN (číslo se pak hlásí jako
 * „—", což vypadá jako nález o datech). Indexovat se musí `env.db[i]`.
 */
function spadZdroje(spec, f0, H = 6) {
  const env = spectralEnvelope(spec);
  const hs = harmonicke(spec, f0, 5000).slice(0, H);
  if (hs.length < 4) return null;
  const pts = [];
  for (const x of hs) {
    if (x.idx < 1 || x.idx >= env.db.length - 1) continue;
    pts.push({ x: Math.log2(x.h), y: x.db - env.db[x.idx] });
  }
  if (pts.length < 4) return null;
  const mx = mean(pts.map(p => p.x)), my = mean(pts.map(p => p.y));
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  const sklon = den ? num / den : NaN;                 // dB na oktávu
  // reziduum = jak daleko od přímky (míra, že to opravdu je spád, ne shluk)
  let r2 = 0, ss = 0;
  for (const p of pts) { const fit = my + sklon * (p.x - mx); r2 += (p.y - fit) ** 2; ss += (p.y - my) ** 2; }
  return { sklon, reziduum: Math.sqrt(r2 / pts.length), r2: ss ? 1 - r2 / ss : NaN, n: pts.length };
}

/** PRAVDA: spád zdroje v dB/oktávu je z definice 20·log10(2)·p. */
const pravySpad = (p) => 20 * Math.log10(2) * p;

/* DIAGNOSTIKA: proč `spadZdroje` vrací null? (aby se nehádalo) */
function procNull(spec, f0, H = 6) {
  const env = spectralEnvelope(spec);
  const hs = harmonicke(spec, f0, 5000).slice(0, H);
  const pts = hs.filter(x => x.idx >= 1 && x.idx < env.db.length - 1);
  return { hCelkem: harmonicke(spec, f0, 5000).length, hPoSlice: hs.length, envLen: env.db.length,
    envJeObjekt: !!env, dbJePole: env.db, pts: pts.length };
}

function zmerSpad(samples, f0, H = 6) {
  const spec = ltas(samples, SR, 4096);
  return spec ? spadZdroje(spec, f0, H) : null;
}

/* ══ 1. TRESNUTÍ PRAVDY: trefí spád zdroje? ═══════════════════════════════ */

console.log('\n══ 1. SPÁD ZDROJE vs PRAVDA (mění se jen zdroj, formanty stojí) ══');
console.log('   p  pravda dB/okt   změřeno   chyba   reziduum   r²');
{
  const F = [500, 1500, 2500];
  for (const f0 of [131, 262]) {
    console.log(`  -- f0 = ${f0} Hz --`);
    for (const p of [0.2, 0.6, 1.0, 1.4, 1.8]) {
      const z = zmerSpad(ton(f0, 1.6, { zdrojSpad: p, F }), f0);
      console.log(`  ${fmt(p, 1)}  ${String(fmt(pravySpad(p), 1)).padStart(11)}  ` +
        `${String(fmt(z.sklon, 1)).padStart(9)}  ${String(fmt(z.sklon - pravySpad(p), 1)).padStart(6)}  ` +
        `${String(fmt(z.reziduum, 2)).padStart(8)}  ${String(fmt(z.r2, 3)).padStart(6)}`);
    }
  }
}

/* ══ 2. FALEŠNÝ POPLACH: hne se jen samohláska ══════════════════════════ */

console.log('\n══ 2. ROZPTYL MEZI SAMOHLÁSKAMI (zdroj stejný p=1,0) ══');
console.log('   (malý rozptyl = metrika se neplete se samohláskou)');
{
  const samohlasky = {
    'á [500,1500,2500]': [500, 1500, 2500],
    'é [400,2000,2600]': [400, 2000, 2600],
    'í [300,2300,3000]': [300, 2300, 3000],
    'ó [450,900,2400]': [450, 900, 2400],
    'ú [350,800,2300]': [350, 800, 2300],
  };
  console.log('   f0     metrika                          rozptyl mezi samohláskami');
  for (const f0 of [131, 262, 392]) {
    const spad = [], h1h2 = [];
    for (const [, F] of Object.entries(samohlasky)) {
      const s = ton(f0, 1.6, { zdrojSpad: 1.0, F });
      spad.push(zmerSpad(s, f0).sklon);
      const H = harmonicke(ltas(s, SR, 4096), f0);
      const h1 = H.find(x => x.h === 1), h2 = H.find(x => x.h === 2);
      h1h2.push(h1 && h2 ? h1.db - h2.db : NaN);
    }
    console.log(`   ${String(f0).padStart(3)}    spád zdroje (dB/okt)           ${String(fmt(Math.max(...spad) - Math.min(...spad), 2)).padStart(6)} dB/okt`);
    console.log(`        H1–H2 (dnešní praxe)           ${String(fmt(Math.max(...h1h2) - Math.min(...h1h2), 2)).padStart(6)} dB`);
  }
}

/* ══ 3. ODOLNOST reálného zpěvu ════════════════════════════════════════ */

console.log('\n══ 3. ODOLNOST — vibrato a doprovod (pravda p = 1,0 → 6,0 dB/okt) ══');
{
  const F = [500, 1500, 2500], f0 = 262;
  for (const [nazev, cfg] of [
    ['čistý držený tón', {}],
    ['vibrato 5,5 Hz / 3 %', { vibProc: 0.03 }],
    ['vibrato 6,5 Hz / 6 %', { vibProc: 0.06 }],
  ]) {
    const z = zmerSpad(ton(f0, 1.6, { ...cfg, F }), f0);
    console.log(`  ${nazev.padEnd(24)} spád ${String(fmt(z.sklon, 2)).padStart(6)} dB/okt  reziduum ${fmt(z.reziduum, 2)}  r² ${fmt(z.r2, 3)}`);
  }
}

/* ══ 4. DÉLKA TRAKTU (poloha hrtanu) z rozestupu formantů ══════════════ */

console.log('\n══ 4. DÉLKA TRAKTU z F1–F3 (co aplikace už měří) ══');
console.log('   VTL = 34300 / (2·dF),  dF = průměrný rozestup formantů');
{
  const F0 = [500, 1500, 2500];
  const dF = (F) => ((F[1] - F[0]) + (F[2] - F[1])) / 2;
  const vtl = (F) => 34300 / (2 * dF(F));
  console.log(`   základ F=[500,1500,2500] → dF ${fmt(dF(F0), 1)} Hz, VTL ${fmt(vtl(F0), 2)} cm`);
  console.log('   k      měřené formanty (LPC)     dF změř  VTL odhad  VTL pravda  chyba');
  for (const k of [0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15]) {
    const F = F0.map(x => x * k);
    const zm = formantyLpc(ton(262, 1.6, { F }), 262);
    if (!zm) { console.log(`   ${fmt(k, 2)}   — LPC nenašel 3 formanty`); continue; }
    console.log(`   ${fmt(k, 2)}   ${zm.map(x => Math.round(x)).join('/').padEnd(24)} ` +
      `${String(fmt(dF(zm), 1)).padStart(7)}  ${String(fmt(vtl(zm), 2)).padStart(9)}  ` +
      `${String(fmt(vtl(F), 2)).padStart(10)}  ${String(fmt(vtl(zm) - vtl(F), 2)).padStart(5)}`);
  }
  // A co udělá SAMOHLÁSKA — to je past, kterou musí metrika přežít
  console.log('\n   Falešný poplach: hne se jen samohláska (VTL pravda = 17,15 cm pro všechny)');
  const sam = { 'á': [500, 1500, 2500], 'é': [400, 2000, 2600], 'í': [300, 2300, 3000],
                'ó': [450, 900, 2400], 'ú': [350, 800, 2300] };
  const odhady = [];
  for (const [n, F] of Object.entries(sam)) {
    const zm = formantyLpc(ton(262, 1.6, { F }), 262);
    if (!zm) continue;
    const v = vtl(zm);
    odhady.push(v);
    console.log(`     ${n}  formanty ${zm.map(x => Math.round(x)).join('/').padEnd(20)} VTL odhad ${String(fmt(v, 2)).padStart(6)} cm  (chyba ${fmt(v - vtl(F), 2)})`);
  }
  if (odhady.length > 1) console.log(`     → rozptyl odhadu mezi samohláskami: ${fmt(Math.max(...odhady) - Math.min(...odhady), 2)} cm`);
}

/** Tři formanty z LTAS přes stejný princip, jaký používá aplikace (LPC Burg). */
function formantyLpc(samples, f0) {
  const spec = ltas(samples, SR, 4096);
  if (!spec) return null;
  const { freq, db, binHz } = spec;
  const env = spectralEnvelope(spec, 0.02);
  const lo = Math.round(250 / binHz), hi = Math.round(4200 / binHz);
  const har = [];
  for (let h = 1; h * f0 < 4200; h++) har.push(h * f0);
  const kandidati = [];
  for (let i = lo + 1; i <= hi - 1; i++) {
    if (env[i] > env[i - 1] && env[i] >= env[i + 1]) {
      if (har.some(f => Math.abs(freq[i] - f) < 60)) continue;
      kandidati.push({ f: freq[i], v: env[i] });
    }
  }
  kandidati.sort((a, b) => b.v - a.v);
  const vybrane = [];
  for (const k of kandidati) {
    if (vybrane.every(x => Math.abs(x - k.f) > 300)) vybrane.push(k.f);
    if (vybrane.length === 3) break;
  }
  return vybrane.length === 3 ? vybrane.sort((a, b) => a - b) : null;
}
