#!/usr/bin/env node
/**
 * EXPERIMENT: dají se z nahrávky číst ADDUKCE hlasivek a POLOHA HRTANU?
 *
 * PROČ tenhle experiment existuje: literatura je k H1–H2 jako ukazateli
 * addukce KRITICKÁ (Simpson 2012: „first and second harmonics should NOT be
 * used to measure breathiness"; Kreiman 2012; Samlan 2011 — směr změny závisí
 * na tvaru hlasivek a na tvaru vokálního traktu). Než se cokoli přidá do
 * aplikace, musí se změřit, co ta veličina na SKUTEČNÉM signálu umí.
 *
 * Metoda: syntetický hlas se ZNÁMOU PRAVDOU.
 *   - amplitudy harmonických jsou dané z definice (zdrojový spád × rezonanční
 *     obálka), takže H1–H2 i H1–A1 jsou spočitatelné dopředu
 *   - „addukce" se simuluje jen změnou ZDROJOVÉHO SPÁDU (pressed = strmý,
 *     breathy = plochý) při STEJNÝCH formantech — to je poctivý test
 *   - „hrtan" se simuluje změnou DÉLKY TRAKTU (všechny formanty se škálují)
 *
 * Klíčová otázka není „vyjde číslo", ale:
 *   1. trefí se PRAVDA? (jinak je to měřidlo, které lže)
 *   2. pozná změnu addukce, i když se formanty nehnou? (citlivost)
 *   3. ZMĚNÍ SE, když se hnou JEN formanty? (falešný poplach — to je ta past
 *      z literatury: stejný „hlas" jiná samohláska → jiné H1–H2)
 *
 * Použití: node tools/exp-formanty-hlas.mjs
 */
import { ltas } from '../src/analysis.js';

const mean = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
const sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); };
const fmt = (v, d = 1) => (v === v && v !== null ? v.toFixed(d) : '—');

const SR = 48000;

/* ── syntéza hlasu s předepsanou strukturou ─────────────────────────────── */

/** Rezonanční obálka traktu: F1, F2, F3 + shluk zpěváckého formantu (F3–F5). */
function traktGain(f, F = [500, 1500, 2500], sirky = [120, 180, 220]) {
  const res = (fc, bw, a) => a / (1 + ((f - fc) / bw) ** 2);
  return res(F[0], sirky[0], 1.0) + res(F[1], sirky[1], 0.45)
       + res(F[2], sirky[2], 0.30) + res(3000, 250, 0.22) + res(3500, 300, 0.10);
}

/**
 * Vyrobí držený tón. `zdrojSpad` = exponent 1/h^p:
 *   velké p = strmý spád = málo energie na H1 = „pressed" (sevřené hlasivky)
 *   malé  p = plochý spád = hodně energie na H1 = „breathy" (volné hlasivky)
 * Fáze se INTEGRUJE (φ += 2πf/SR), ne počítá jako sin(2πf·i) — fázově
 * nespojitá syntéza dělá artefakty (ověřeno dřív u vibrata).
 */
function ton(f0, sekund = 1.6, { zdrojSpad = 1.0, F = [500, 1500, 2500],
                                vibProc = 0, vibHz = 5.5, sumDb = null, seed = 1 } = {}) {
  const n = Math.round(sekund * SR);
  const out = new Float64Array(n);
  let rnd = seed >>> 0;
  const rand = () => (rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296;
  let fi = 0, suma = 0;
  for (let i = 0; i < n; i++) {
    const f = f0 * (1 + vibProc * Math.sin(2 * Math.PI * vibHz * i / SR));
    fi += 2 * Math.PI * f / SR;
    let s = 0;
    for (let h = 1; h * f0 < 6000; h++) {
      const fh = h * f0;
      const amp = traktGain(fh, F) / h ** zdrojSpad;
      s += amp * Math.sin(h * fi);
    }
    // okna na začátku/konci, ať segmentace vidí čistý tón
    const fade = Math.min(1, i / 1200) * Math.min(1, (n - i) / 1200);
    out[i] = 0.25 * s * fade;
  }
  // šum (telefon / místnost) a doprovodný tón (klavír pod hlasem)
  if (sumDb !== null) {
    const a = 10 ** (sumDb / 20);
    for (let i = 0; i < n; i++) out[i] += a * 0.5 * Math.sin(2 * Math.PI * 440 * i / SR);
  }
  return out;
}

/** Harmonické s přesnou f0 (pro měření): vrátí [{h, f, db}] s interpolací. */
function harmonicke(spec, f0, doHz = 6000) {
  const { freq, db } = spec;
  const out = [];
  for (let h = 1; h * f0 < doHz; h++) {
    const f = h * f0;
    if (f < spec.binHz * 2) continue;
    const lo = Math.max(0, Math.round((f - 0.35 * f0) / spec.binHz));
    const hi = Math.min(freq.length - 1, Math.round((f + 0.35 * f0) / spec.binHz));
    let bi = -1, bv = -Infinity;
    for (let i = lo; i <= hi; i++) if (db[i] > bv) { bv = db[i]; bi = i; }
    if (bi <= 0 || bi >= freq.length - 2 || bv === -Infinity) continue;
    // parabolická interpolace vrcholu (kvantování binu jinak dělá 0,3 dB šum)
    const y0 = db[bi - 1], y1 = db[bi], y2 = db[bi + 1];
    const d = 0.5 * (y0 - y2) / ((y0 - 2 * y1 + y2) || 1e-9);
    out.push({ h, f, db: y1 - 0.25 * (y0 - y2) * d, bin: bi });
  }
  return out;
}

const najdi = (H, h) => H.find(x => x.h === h);

/** H1–H2 a H1–A1/A3 z harmonických. A1/A3 = harmonická nejblíž formantu. */
function miry(H, F) {
  const h1 = najdi(H, 1), h2 = najdi(H, 2);
  const nejbliz = (fc) => H.reduce((b, x) => (Math.abs(x.f - fc) < Math.abs((b?.f ?? 1e9) - fc) ? x : b), null);
  const a1 = nejbliz(F[0]), a3 = nejbliz(F[2]);
  return {
    H1H2: h1 && h2 ? h1.db - h2.db : NaN,
    H1A1: h1 && a1 ? h1.db - a1.db : NaN,
    H1A3: h1 && a3 ? h1.db - a3.db : NaN,
  };
}

/** PRAVDA z definice: amplitudy harmonických znám z generátoru. */
function pravda(f0, { zdrojSpad, F }) {
  const amp = (h) => traktGain(h * f0, F) / h ** zdrojSpad;
  const H = [];
  for (let h = 1; h * f0 < 6000; h++) H.push({ h, f: h * f0, db: 20 * Math.log10(amp(h)) });
  return miry(H, F);
}

function zmer(samples, f0, F) {
  const spec = ltas(samples, SR, 4096);
  if (!spec) return null;
  return miry(harmonicke(spec, f0), F);
}

/* ══ 1. Addukce: mění se JEN zdrojový spád, formanty stojí ═══════════════ */

console.log('\n══ 1. ADDUKCE — mění se jen zdrojový spád, formanty stejné ══');
console.log('(p = exponent 1/h^p: malé = breathy/volné, velké = pressed/sevřené)');
console.log('  f0    p    H1H2 pravda  změřeno   chyba | H1A1 pravda  změřeno | H1A3 pravda  změřeno');
{
  const F = [500, 1500, 2500];
  for (const f0 of [131, 262, 392]) {
    for (const p of [0.3, 1.0, 1.7]) {
      const cfg = { zdrojSpad: p, F };
      const s = ton(f0, 1.6, cfg);
      const z = zmer(s, f0, F);
      const t = pravda(f0, cfg);
      console.log(`  ${String(f0).padStart(3)}  ${fmt(p, 1)}  ` +
        `${String(fmt(t.H1H2)).padStart(9)}  ${String(fmt(z.H1H2)).padStart(8)}  ${String(fmt(z.H1H2 - t.H1H2)).padStart(6)} | ` +
        `${String(fmt(t.H1A1)).padStart(9)}  ${String(fmt(z.H1A1)).padStart(8)} | ` +
        `${String(fmt(t.H1A3)).padStart(9)}  ${String(fmt(z.H1A3)).padStart(8)}`);
    }
  }
}

/* ══ 2. FALEŠNÝ POPLACH: hnou se JEN formanty (samohláska), zdroj stojí ══ */

console.log('\n══ 2. FALEŠNÝ POPLACH — mění se jen formanty (samohláska), zdroj stejný ══');
console.log('(když se číslo hne, ačkoli se addukce nezměnila, měřidlo lže)');
{
  const samohlasky = {
    'á  F=[500,1500,2500]': [500, 1500, 2500],
    'é  F=[400,2000,2600]': [400, 2000, 2600],
    'í  F=[300,2300,3000]': [300, 2300, 3000],
    'ó  F=[450,900,2400]': [450, 900, 2400],
    'ú  F=[350,800,2300]': [350, 800, 2300],
  };
  for (const f0 of [131, 262, 392]) {
    const radky = [];
    for (const [nazev, F] of Object.entries(samohlasky)) {
      const z = zmer(ton(f0, 1.6, { zdrojSpad: 1.0, F }), f0, F);
      radky.push({ nazev, ...z });
    }
    const rozp = (k) => Math.max(...radky.map(r => r[k])) - Math.min(...radky.map(r => r[k]));
    console.log(`\n  f0 = ${f0} Hz`);
    for (const r of radky) console.log(`    ${r.nazev}  H1H2 ${String(fmt(r.H1H2)).padStart(6)}  H1A1 ${String(fmt(r.H1A1)).padStart(6)}  H1A3 ${String(fmt(r.H1A3)).padStart(6)}`);
    console.log(`    → ROZPTYL mezi samohláskami: H1H2 ${fmt(rozp('H1H2'))} dB, H1A1 ${fmt(rozp('H1A1'))} dB, H1A3 ${fmt(rozp('H1A3'))} dB`);
  }
}

/* ══ 3. POLOHA HRTANU: škálování délky traktu (VTL) ═════════════════════ */

console.log('\n══ 3. POLOHA HRTANU — škáluji všechny formanty (délka traktu) ══');
console.log('(odhad VTL z rozestupu formantů dF: VTL = 34300 / (2·dF) cm)');
{
  const F0 = [500, 1500, 2500];
  const dF = (F) => ((F[1] - F[0]) + (F[2] - F[1])) / 2;
  const vtl = (F) => 34300 / (2 * dF(F));
  const vtlPrava = vtl(F0);
  console.log(`  základ: F=${F0.join('/')} → dF ${fmt(dF(F0))} Hz, VTL ${fmt(vtlPrava)} cm`);
  console.log('  k     formanty               dF změř.  VTL odhad  VTL pravda  chyba');
  for (const k of [0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15]) {
    const F = F0.map(x => x * k);
    // změřeno: formanty z LPC spektra přes skutečný analyzátor
    const spec = ltas(ton(262, 1.6, { F }), SR, 4096);
    const zm = najdiFormanty(spec, 262);
    if (!zm) { console.log(`  ${fmt(k, 2)}  — formanty se nepodařilo najít`); continue; }
    const ch = vtl(zm) - vtl(F);
    console.log(`  ${fmt(k, 2)}  ${zm.map(x => Math.round(x)).join('/')}`.padEnd(30) +
      `${String(fmt(dF(zm))).padStart(9)}  ${String(fmt(vtl(zm))).padStart(9)}  ${String(fmt(vtl(F))).padStart(10)}  ${String(fmt(ch)).padStart(5)}`
      .padStart(4));
  }
}

/** Formanty z LTAS: tři největší vrcholy obálky v 200–4000 Hz (bez f0). */
function najdiFormanty(spec, f0) {
  if (!spec) return null;
  const { freq, db, binHz } = spec;
  const lo = Math.round(250 / binHz), hi = Math.round(4000 / binHz);
  const hledej = [];
  for (let h = 1; h * f0 < 4000; h++) hledej.push(h * f0);
  const kandidati = [];
  for (let i = lo; i <= hi; i++) {
    if (db[i] > db[i - 1] && db[i] >= db[i + 1]) {
      // vynech harmonické základního tónu — hledáme obálku, ne špičky H
      if (hledej.some(f => Math.abs(freq[i] - f) < 40)) continue;
      kandidati.push({ f: freq[i], v: db[i] });
    }
  }
  kandidati.sort((a, b) => b.v - a.v);
  const vybrane = [];
  for (const k of kandidati) {
    if (vybrane.every(x => Math.abs(x - k.f) > 250)) vybrane.push(k.f);
    if (vybrane.length === 3) break;
  }
  return vybrane.length === 3 ? vybrane.sort((a, b) => a - b) : null;
}

/* ══ 4. ODOLNOST: vibrato, doprovod, šum ═════════════════════════════════ */

console.log('\n══ 4. ODOLNOST — co s H1–H2 udělá reálný zpěv ══');
{
  const F = [500, 1500, 2500], f0 = 262;
  const zaklad = zmer(ton(f0, 1.6, { F }), f0, F);
  console.log(`  čistý držený tón        H1H2 ${fmt(zaklad.H1H2)} dB  (pravda ${fmt(pravda(f0, { zdrojSpad: 1, F }).H1H2)})`);
  const pripady = [
    ['vibrato 5,5 Hz / 3 %', { F, vibProc: 0.03 }],
    ['vibrato 6,5 Hz / 6 %', { F, vibProc: 0.06 }],
    ['doprovod −18 dBFS', { F, sumDb: -18 }],
    ['doprovod −12 dBFS', { F, sumDb: -12 }],
    ['převzorkováno na 16 kHz', null],
  ];
  for (const [nazev, cfg] of pripady) {
    if (!cfg) {
      const s = ton(f0, 1.6, { F });
      let r = 0;
      for (let i = 0; i < s.length; i++) r += s[i] * Math.sin(2 * Math.PI * 0.5 * i);
      const dec = new Float64Array(Math.floor(s.length / 3));
      for (let i = 0; i < dec.length; i++) dec[i] = (s[3 * i] + s[3 * i + 1] + s[3 * i + 2]) / 3;
      const spec = ltas(dec, SR / 3, 4096);
      const z = miry(harmonicke(spec, f0), F);
      console.log(`  ${nazev.padEnd(24)} H1H2 ${fmt(z.H1H2)} dB  (změna ${fmt(z.H1H2 - zaklad.H1H2)})`);
      continue;
    }
    const z = zmer(ton(f0, 1.6, cfg), f0, F);
    console.log(`  ${nazev.padEnd(24)} H1H2 ${fmt(z.H1H2)} dB  (změna ${fmt(z.H1H2 - zaklad.H1H2)})`);
  }
}
