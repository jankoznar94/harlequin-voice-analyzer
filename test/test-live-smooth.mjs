#!/usr/bin/env node
/**
 * Test vyhlazení ručičky ladění v živém režimu.
 *
 * Hlídá tři věci, z nichž každá se dá snadno potichu rozbít:
 *
 *   1. Vyhlazení SKUTEČNĚ sráží cukání mezi rámci. Bez toho je to jen kód
 *      navíc, který nic nedělá (a nikdo si toho nevšimne).
 *   2. Rozptyl ladění a historie pro souhrn zůstávají ze SUROVÝCH hodnot.
 *      Kdyby se počítaly z vyhlazených, vyšlo by vibrato uměle menší
 *      a číslo by lhalo o tom, jak přesně se tón drží.
 *   3. Při přeskočení na jiný tón se vyhlazení restartuje. Jinak ručička
 *      při novém tónu dojíždí z předchozí polohy a hlásí rozladění, které
 *      tam není.
 *
 * Použití: node test/test-live-smooth.mjs
 */
import { createLiveState, feedFrame, CENTS_SMOOTH_ALPHA, CENTS_RESET_CENTS } from '../src/live.js';
import { createDsp } from '../src/dsp-backend.js';

const SR = 48000, FRAME = 2048, HOP = 960;

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const FORM = [[700, 80, 1], [1200, 110, 0.55], [2600, 180, 0.35]];
function ampAt(f) { let a = 0; for (const [fc, bw, g] of FORM) a += g / (1 + Math.pow((f - fc) / bw, 2)); return a + 0.02; }
/** Tón s vibratem — přesně to, na čem surová ručička cuká. */
function tone(f0, dur, { vibRate = 5.6, vibDepth = 0.03, seed = 5 } = {}) {
  const n = Math.round(SR * dur), o = new Float64Array(n), r = rng(seed);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (0.03 * SR)) * Math.min(1, (n - i) / (0.04 * SR));
    const inst = f0 * (1 + vibDepth * Math.sin(2 * Math.PI * vibRate * i / SR));
    ph += 2 * Math.PI * inst / SR;
    let v = 0;
    for (let h = 1; h * inst < 5200; h++) v += ampAt(h * inst) * Math.sin(h * ph) / Math.sqrt(h);
    o[i] = 0.26 * v * env;
  }
  return o;
}
function silence(dur) { return new Float64Array(Math.round(SR * dur)); }
const med = (a) => { const s = [...a].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

/** Prožene signál živou cestou a vrátí surové i vyhlazené odchylky. */
async function run(x) {
  const dsp = await createDsp({ frameSize: FRAME, sampleRate: SR, fach: 'tenor' });
  dsp.reset();
  const st = createLiveState(SR, FRAME);
  const raw = [], shown = [], notes = [];
  for (let o = 0; o + FRAME <= x.length; o += HOP) {
    const s = feedFrame(st, dsp, x.subarray(o, o + FRAME));
    raw.push(s.cents);
    shown.push(s.centsShown);
    notes.push(s.note);
  }
  return { state: st, raw, shown, notes };
}

const flips = (seq) => {
  const d = [];
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] != null && seq[i - 1] != null) d.push(Math.abs(seq[i] - seq[i - 1]));
  }
  return d;
};

/* ── 1. vyhlazení sráží cukání ───────────────────────────────────────────── */
console.log('\n1. Vyhlazení musí cukání skutečně srazit\n');
{
  const { raw, shown } = await run(tone(392, 3));
  const dRaw = flips(raw), dSho = flips(shown);
  const p90raw = pct(dRaw, 0.9), p90sho = pct(dSho, 0.9);
  console.log(`  surová: medián ${med(dRaw).toFixed(0)} c, 90. pctl ${p90raw.toFixed(0)} c, max ${Math.max(...dRaw).toFixed(0)} c`);
  console.log(`  vyhlazená: medián ${med(dSho).toFixed(0)} c, 90. pctl ${p90sho.toFixed(0)} c, max ${Math.max(...dSho).toFixed(0)} c`);
  ok('vyhlazená ručička cuká méně (90. percentil klesl aspoň o třetinu)',
    p90sho < p90raw * 0.66, `${p90raw.toFixed(0)} → ${p90sho.toFixed(0)} c`);
  ok('vyhlazená ručička nikdy neskáče víc než surová',
    Math.max(...dSho) <= Math.max(...dRaw) + 1e-9,
    `${Math.max(...dRaw).toFixed(0)} vs ${Math.max(...dSho).toFixed(0)} c`);
}

/* ── 2. rozptyl zůstává ze SUROVÝCH hodnot ──────────────────────────────── */
console.log('\n2. Rozptyl ladění nesmí být vyhlazený (jinak lže o vibratu)\n');
{
  const { state, raw, shown } = await run(tone(392, 3));
  const nRaw = state.centsHist.length;
  ok('do historie pro rozptyl šly všechny zpívané rámce', nRaw === raw.filter(v => v != null).length,
    `${nRaw} vs ${raw.filter(v => v != null).length}`);

  // historie musí odpovídat SUROVÝM hodnotám, ne vyhlazeným
  const histRaw = state.centsHist;
  let matchesRaw = 0;
  const raws = raw.filter(v => v != null);
  for (let i = 0; i < Math.min(histRaw.length, raws.length); i++) {
    if (Math.abs(histRaw[i] - raws[i]) < 1e-9) matchesRaw++;
  }
  ok('historie pro rozptyl odpovídá surovým hodnotám', matchesRaw === Math.min(histRaw.length, raws.length),
    `${matchesRaw}/${histRaw.length}`);

  // rozptyl surových hodnot musí být větší než vyhlazených — jinak by test nic nehlídal
  const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
  const sdRaw = sd(raws), sdSho = sd(shown.filter(v => v != null));
  ok('rozptyl ze surových hodnot je větší než z vyhlazených (vyhlazení opravdu ubírá)',
    sdRaw > sdSho * 1.5, `směrodatná odchylka ${sdRaw.toFixed(1)} vs ${sdSho.toFixed(1)} c`);
}

/* ── 3. restart při přeskočení na jiný tón ──────────────────────────────── */
console.log('\n3. Přeskočení na jiný tón musí vyhlazení restartovat\n');
{
  // ticho → tón: hodnota musí být hned ta správná, ne dojíždět z prázdna
  const x = new Float64Array(Math.round(SR * 0.5) + Math.round(SR * 1.5));
  x.set(silence(0.5), 0);
  x.set(tone(440, 1.5), Math.round(SR * 0.5));
  const { shown, raw } = await run(x);
  const firstVoiced = raw.findIndex(v => v != null);
  ok('po tichu začíná vyhlazená hodnota přesně na surové',
    firstVoiced >= 0 && Math.abs(shown[firstVoiced] - raw[firstVoiced]) < 1e-9,
    firstVoiced >= 0 ? `${shown[firstVoiced]?.toFixed(1)} vs ${raw[firstVoiced]?.toFixed(1)}` : 'žádný zpívaný rámec');

  // skok na tón o hodně jinde: vyhlazení se musí restartovat (ne dojíždět)
  const y = new Float64Array(Math.round(SR * 1.2) + Math.round(SR * 1.2));
  y.set(tone(392, 1.2, { vibDepth: 0 }), 0);
  y.set(tone(659, 1.2, { vibDepth: 0 }), Math.round(SR * 1.2));
  const r2 = await run(y);
  const boundary = Math.round(SR * 1.2 / HOP);
  let restartOk = true, worst = 0;
  for (let i = boundary + 2; i < boundary + 12 && i < r2.raw.length; i++) {
    if (r2.raw[i] == null || r2.shown[i] == null) continue;
    const gap = Math.abs(r2.raw[i] - r2.shown[i]);
    if (gap > worst) worst = gap;
  }
  restartOk = worst < 30;
  ok('po skoku na vzdálený tón ručička neujíždí (do 30 c od surové)', restartOk,
    `největší odchylka ${worst.toFixed(0)} c po skoku`);
}

/* ── 4. konstanty jsou v rozumném rozsahu ───────────────────────────────── */
console.log('\n4. Konstanty vyhlazení\n');
{
  ok('CENTS_SMOOTH_ALPHA je mezi 0 a 1', CENTS_SMOOTH_ALPHA > 0 && CENTS_SMOOTH_ALPHA < 1, String(CENTS_SMOOTH_ALPHA));
  ok('CENTS_SMOOTH_ALPHA není tak malá, že by ručička zaostávala (> 0,15)',
    CENTS_SMOOTH_ALPHA > 0.15, `${CENTS_SMOOTH_ALPHA} → zpoždění ~${(20 / CENTS_SMOOTH_ALPHA).toFixed(0)} ms`);
  ok('CENTS_RESET_CENTS je větší než půltón, aby neshazoval vyhlazení uvnitř tónu',
    CENTS_RESET_CENTS > 100, String(CENTS_RESET_CENTS));
}

console.log(`\n═══ VYHLAZENÍ RUČIČKY: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══\n`);
process.exit(fails ? 1 : 0);
