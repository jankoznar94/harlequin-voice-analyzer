#!/usr/bin/env node
/**
 * Ověření živé cesty BEZ mikrofonu.
 *
 * Na tomto stroji nemá headless prohlížeč zvukový vstup, takže „mikrofon →
 * indikátor" ověřit nelze. Ověřit se ale dá všechno ostatní a je to ta
 * důležitější část:
 *
 *   1. Živé SPR znamená TOTÉŽ co SPR z nahrávky. Kdyby ne, indikátor by při
 *      zpívání ukazoval jiné číslo, než jaké pak uvidíš ve výsledku — a to je
 *      horší než indikátor nemít. Testuje se na ustáleném tónu, protože jen
 *      tam mají obě čísla jednoznačný smysl.
 *   2. Živá cesta najde stejnou výšku jako offline pitchTrack.
 *   3. Indikátor se chová rozumně v krajních stavech: ticho, šum, přebuzení.
 *   4. WASM a záložní JS dávají v živém režimu stejná čísla.
 *
 * Použití: node tools/live-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { analyze, ltas, spr, pitchTrack } from '../src/analysis.js';
import { createLiveState, feedFrame, summarizeLive, centsFromNote } from '../src/live.js';
import { createDsp, loadWasm } from '../src/dsp-backend.js';

const ROOT = path.join(import.meta.dirname, '..');
const WASM = path.join(ROOT, 'wasm', 'build', 'dsp.wasm');

const SR = 48000;
const FRAME = 2048;
const HOP = 960;                 // 20 ms

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

/* ── signály ─────────────────────────────────────────────────────────────── */

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Ustálený zpěvný tón s formantovou obálkou.
 *
 * Obálka je podstatná: SPR porovnává energii 2–4 kHz proti 0–2 kHz, takže
 * čistý sinus by dal SPR hluboko záporné (vše je v 0–2 kHz) a nebylo by co
 * srovnávat. Tón s rezonancemi jako skutečný hlas má obě pásma obsazená.
 */
function steadyTone(f0 = 440, dur = 4, { bright = 1, seed = 5 } = {}) {
  const n = Math.round(SR * dur);
  const out = new Float64Array(n);
  const rnd = mulberry32(seed);
  // tři formanty — F1 ~700, F2 ~1200, F3 ~2600 Hz
  const formants = [[700, 80, 1.0], [1200, 110, 0.55], [2600, 180, 0.35 * bright]];
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    phase += 2 * Math.PI * f0 / SR;
    let v = 0;
    // harmonické do ~5 kHz, amplituda podle formantové obálky
    for (let h = 1; h * f0 < 5200; h++) {
      const f = h * f0;
      let amp = 0;
      for (const [fc, bw, g] of formants) {
        amp += g / (1 + Math.pow((f - fc) / bw, 2));
      }
      amp += 0.02;                             // jemný základ, ať nic není nula
      v += amp * Math.sin(phase * h) / Math.sqrt(h);
    }
    out[i] = 0.28 * v + (rnd() - 0.5) * 3e-4;
  }
  return out;
}

function silence(dur = 2) { return new Float64Array(Math.round(SR * dur)); }

function noiseSignal(dur = 2, seed = 9) {
  const n = Math.round(SR * dur);
  const out = new Float64Array(n);
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) out[i] = (rnd() - 0.5) * 0.3;
  return out;
}

/* ── živý průchod ────────────────────────────────────────────────────────── */

/**
 * Prožene signál živou cestou po blocích, jako by přicházel z mikrofonu.
 * Vrací jak souhrn, tak poslední snapshot (stav indikátoru na konci).
 */
async function runLive(samples, { fach = 'tenor', useWasm = true } = {}) {
  const dsp = await createDsp({
    frameSize: FRAME, sampleRate: SR, fach,
    wasmUrl: useWasm ? WASM : undefined,
    force: useWasm ? undefined : 'js',
  });
  if (!useWasm && dsp.kind === 'wasm') throw new Error('čekal jsem JS backend');
  if (useWasm && dsp.kind !== 'wasm') throw new Error('WASM backend se nenačetl: ' + dsp.kind);
  dsp.reset();
  const state = createLiveState(SR, FRAME);

  let last = null;
  // okno se posouvá po HOP, ale bere se vždy FRAME vzorků — přesně jako
  // klouzavé okno v AudioWorkletu
  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    last = feedFrame(state, dsp, samples.subarray(start, start + FRAME));
  }
  return { summary: summarizeLive(state), last, kind: dsp.kind };
}

/* ── 1. živé SPR vs SPR z nahrávky ───────────────────────────────────────── */

console.log('\n1. Živé SPR musí znamenat totéž co SPR z nahrávky (ustálený tón)\n');

const tone = steadyTone(440, 4);
{
  // offline: LTAS na ustálené části (přesně to, z čeho analýza nahrávky počítá)
  const spec = ltas(tone, SR, 4096);
  const sprOffline = spr(spec);

  // offline cestou celé analýzy
  const res = analyze(tone, SR, { fach: 'tenor' });
  const sprAnalyze = res.summary.spr_median;

  const { summary, last } = await runLive(tone);

  console.log(`  LTAS 4096 (referenční):    ${sprOffline.toFixed(2)} dB`);
  console.log(`  analyze() medián tónů:     ${Number.isFinite(sprAnalyze) ? sprAnalyze.toFixed(2) : '—'} dB`);
  console.log(`  živě (WASM, okno 2048):    ${summary.sprMedian.toFixed(2)} dB`);
  console.log(`  živě poslední okamžik:     ${last.spr.toFixed(2)} dB\n`);

  const d = Math.abs(summary.sprMedian - sprOffline);
  ok('živé SPR se shoduje s offline do 2 dB', d <= 2.0, `rozdíl ${d.toFixed(2)} dB`);
  ok('živý indikátor ukazuje totéž co poslední okamžik',
    Math.abs(last.spr - summary.sprMedian) < 6, `Δ ${Math.abs(last.spr - summary.sprMedian).toFixed(2)} dB`);
}

/* ── 2. výška ────────────────────────────────────────────────────────────── */

console.log('\n2. Živá výška musí sedět s offline pitchTrack\n');
{
  const tests = [
    ['A2 110 Hz', 110], ['A3 220 Hz', 220], ['A4 440 Hz', 440],
    ['C5 523 Hz', 523], ['E5 659 Hz', 659],
  ];
  for (const [name, f0] of tests) {
    const sig = steadyTone(f0, 3);
    const { summary, last } = await runLive(sig);
    // vezmi poslední zpívaný rámec
    const off = pitchTrack(sig, SR, { frameSize: FRAME, hopSize: HOP });
    const offLast = [...off.f0].reverse().find(v => v > 0) || 0;
    const errCents = Math.abs(1200 * Math.log2(last.f0 / f0));
    ok(`${name}: živě ${last.f0.toFixed(1)} Hz, offline ${offLast.toFixed(1)} Hz`,
      errCents < 10, `${errCents.toFixed(1)} centů od zadané výšky`);
    ok(`${name}: živě a offline se shodují do 5 centů`,
      Math.abs(1200 * Math.log2(last.f0 / offLast)) < 5);
  }
}

/* ── 3. krajní stavy ─────────────────────────────────────────────────────── */

console.log('\n3. Krajní stavy — indikátor nesmí lhát\n');
{
  const { summary, last } = await runLive(silence(2));
  ok('ticho: žádný zpívaný rámec', summary.voicedFrames === 0, `rámců ${summary.frames}`);
  ok('ticho: výška je nula', last.f0 === 0);
  ok('ticho: SPR není k dispozici', !Number.isFinite(last.spr) || summary.sprSamples === 0);
  ok('ticho: úroveň je velmi nízká', summary.peakDbfs < -60, `${summary.peakDbfs.toFixed(1)} dBFS`);
}
{
  const { summary, last } = await runLive(noiseSignal(2));
  ok('šum: nenajde stabilní výšku (málokdy zpíváno)',
    summary.voicedPct < 50, `zpíváno ${summary.voicedPct} % rámců`);
}
{
  // Silný signál: normalizovaný tak, že špička je těsně pod plnou stupnicí.
  // Ověřuje se, že indikátor úrovně opravdu měří, ne že jen něco ukazuje.
  const base = steadyTone(440, 2);
  let peak = 0;
  for (const v of base) peak = Math.max(peak, Math.abs(v));
  const loud = new Float64Array(base.length);
  for (let i = 0; i < base.length; i++) loud[i] = base[i] / peak * 0.98;

  const quiet = new Float64Array(base.length);
  for (let i = 0; i < base.length; i++) quiet[i] = base[i] / peak * 0.098;   // o 20 dB míň

  const a = await runLive(loud);
  const b = await runLive(quiet);
  const diff = a.summary.peakDbfs - b.summary.peakDbfs;
  ok('silný signál: úroveň je vysoko', a.summary.peakDbfs > -9,
    `${a.summary.peakDbfs.toFixed(1)} dBFS`);
  ok('20 dB slabší signál: indikátor ukáže o 20 dB míň', Math.abs(diff - 20) < 1.5,
    `rozdíl ${diff.toFixed(1)} dB`);
}

/* ── 4. WASM vs záložní JS v živém režimu ────────────────────────────────── */

console.log('\n4. WASM a záložní JS musí dávat stejná čísla\n');
{
  const sig = steadyTone(440, 3);
  const w = await runLive(sig, { useWasm: true });
  const j = await runLive(sig, { useWasm: false });

  ok('WASM backend se skutečně použil', w.kind === 'wasm', w.kind);
  ok('JS backend se skutečně použil', j.kind === 'js', j.kind);

  const dSpr = Math.abs(w.summary.sprMedian - j.summary.sprMedian);
  const dF0 = Math.abs(w.last.f0 - j.last.f0);
  const dPct = Math.abs(w.summary.voicedPct - j.summary.voicedPct);
  console.log(`  SPR: WASM ${w.summary.sprMedian.toFixed(2)} vs JS ${j.summary.sprMedian.toFixed(2)} dB`);
  console.log(`  výška: WASM ${w.last.f0.toFixed(2)} vs JS ${j.last.f0.toFixed(2)} Hz`);
  ok('SPR se shoduje do 0,5 dB', dSpr < 0.5, `Δ ${dSpr.toFixed(3)} dB`);
  ok('výška se shoduje do 1 centu', dF0 < 0.3, `Δ ${dF0.toFixed(4)} Hz`);
  ok('podíl zpívaných rámců se shoduje', dPct <= 2, `Δ ${dPct} p.b.`);
}

/* ── 5. ladění a třídy pro UI ────────────────────────────────────────────── */

console.log('\n5. Převod na tón a centy\n');
{
  const cases = [
    [440, 'A4', 0], [445, 'A4', 19.6], [415, 'G#4', -1.3], [410, 'G#4', -22.3],
    [880, 'A5', 0], [261.63, 'C4', 0],
  ];
  for (const [f, note, cents] of cases) {
    const r = centsFromNote(f);
    ok(`${f} Hz → ${note}`, r.note === note, `dostal ${r.note}`);
    ok(`  odchylka ~${cents} centů`, Math.abs(r.cents - cents) < 1.5, `dostal ${r.cents.toFixed(1)}`);
  }
  const n = centsFromNote(0);
  ok('nula Hz → žádný tón', n.note === null && n.cents === null);
}

console.log(`\n═══ ŽIVÁ CESTA: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══\n`);
process.exit(fails ? 1 : 0);
