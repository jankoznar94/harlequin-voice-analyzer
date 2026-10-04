#!/usr/bin/env node
/**
 * PARITA ŽIVĚ ↔ NAHRÁVKA: ukazuje indikátor totéž, co pak vyjde v reportu?
 *
 * Tohle je jádro celé opravy. Živý režim dřív počítal SPR z vyhlazeného PRŮMĚRU
 * spektra rámců 2048 — tedy jiným měřidlem, než jakým se měří nahrávka. Číslo
 * z indikátoru se pak s reportem nedalo srovnat: na drženém tónu s vibratem
 * vycházelo o ~2 dB níž (naměřeno −18,70 proti −16,80).
 *
 * Test hlídá tři věci:
 *   1. `SprCore` (bezalokační cesta pro živý režim) dává BITOVĚ totéž co
 *      `sprInterp(ltas(...))` — jiná implementace téhož měřidla se nesmí rozejít.
 *   2. Živá cesta na nahraném tónu sedí s `sprFrames` (což je přesně to, z čeho
 *      analýza nahrávky počítá `spr_novy_median`) do 1 dB.
 *   3. Živá cesta je na vibratu blíž PRAVDĚ než staré měřidlo — kdyby se
 *      „oprava“ vrátila, test to pozná.
 *
 * Použití: node test/test-live-parity.mjs
 */
import { ltas, sprInterp, sprFrames, analyze, SprCore, sprPower, percentile } from '../src/analysis.js';
import { createLiveState, feedFrame, summarizeLive, BLOCK_MS, FRAME_SIZE, SPR_ROLL_MS } from '../src/live.js';
import { createDsp } from '../src/dsp-backend.js';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const WASM = path.join(ROOT, 'wasm', 'build', 'dsp.wasm');

const SR = 48000;
const HOP = Math.round(SR * BLOCK_MS / 1000);   // 960

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Obálka harmonických — z ní se dá spočítat PRAVDA (poměr dvou vrcholů). */
function envGain(f) {
  const formants = [[700, 80, 1.0], [1200, 110, 0.55], [2600, 180, 0.35]];
  let a = 0;
  for (const [fc, bw, g] of formants) a += g / (1 + Math.pow((f - fc) / bw, 2));
  return a + 0.02;
}

/** Tón s vibratem; fáze se INTEGRUJE (fázově nespojitá syntéza by lhala). */
function tone(f0, dur, { vibDepth = 0, vibRate = 5.5, seed = 5 } = {}) {
  const n = Math.round(SR * dur);
  const out = new Float64Array(n);
  const rnd = mulberry32(seed);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 * (1 + vibDepth * Math.sin(2 * Math.PI * vibRate * t));
    phase += 2 * Math.PI * f / SR;
    let v = 0;
    for (let h = 1; h * f0 < 5200; h++) v += envGain(h * f0) * Math.sin(phase * h) / Math.sqrt(h);
    const env = Math.min(1, i / (SR * 0.05)) * Math.min(1, (n - i) / (SR * 0.10));
    out[i] = 0.28 * v * env + (rnd() - 0.5) * 3e-4;
  }
  return out;
}

/** Pravda: SPR je z definice poměr amplitud dvou největších harmonických. */
function trueSPR(f0) {
  let lo = 0, hi = 0;
  for (let h = 1; h * f0 < 5200; h++) {
    const f = h * f0, a = envGain(f) / Math.sqrt(h);
    if (f < 2000) lo = Math.max(lo, a);
    if (f >= 2000 && f <= 4000) hi = Math.max(hi, a);
  }
  return (lo && hi) ? 20 * Math.log10(hi / lo) : NaN;
}

/** Prožene signál živou cestou po blocích, jako by přicházel z mikrofonu. */
async function runLive(samples) {
  const s = await liveFrames(samples, true);
  return s.summary;
}

/**
 * Prožene signál živou cestou a vrátí buď souhrn, nebo všechny rámce i s časem.
 *
 * ⚠️ Okno pro SPR se drží ZVLÁŠŤ (`sprBuf`), ne z `pending` — ten se ořezává,
 * takže by v něm 4096 vzorků nikdy nebylo. Přesně tuhle chybu měl i samotný
 * kód v `live-run.js`; test, který si ji zopakuje, by ji nechytil (a naměřil
 * by nesmysly z oken doplněných nulami).
 */
async function liveFrames(samples, wantSummary = false) {
  const dsp = await createDsp({ frameSize: FRAME_SIZE, sampleRate: SR, fach: 'tenor', wasmUrl: WASM });
  if (dsp.kind !== 'wasm') throw new Error('WASM se nenačetl');
  const state = createLiveState(SR, FRAME_SIZE);
  const sprNfft = state.sprCore.nfft;
  let pending = new Float64Array(0);
  let sprBuf = new Float64Array(0);
  const recs = [];
  for (let b = 0; b + HOP <= samples.length; b += HOP) {
    const block = samples.subarray(b, b + HOP);
    sprBuf = appendKeepLocal(sprBuf, block, sprNfft);
    const merged = new Float64Array(pending.length + block.length);
    merged.set(pending, 0); merged.set(block, pending.length);
    let off = 0;
    while (merged.length - off >= FRAME_SIZE) {
      const end = off + FRAME_SIZE;
      const sprWin = sprBuf.length >= sprNfft ? sprBuf.subarray(sprBuf.length - sprNfft) : null;
      const snap = feedFrame(state, dsp, merged.subarray(off, end), sprWin);
      recs.push({ t: (b + end) / SR, f0: snap.f0, dbfs: snap.dbfs, spr: snap.spr, sprLast: snap.sprLast, sprOld: snap.sprOld });
      off += HOP;
    }
    pending = merged.slice(off);
  }
  return wantSummary ? { summary: summarizeLive(state), recs } : recs;
}

/** Posledních `keep` hodnot — stejná logika jako `appendKeep` v live-run.js. */
function appendKeepLocal(buf, block, keep) {
  const total = buf.length + block.length;
  if (total <= keep) {
    const out = new Float64Array(total);
    out.set(buf, 0); out.set(block, buf.length);
    return out;
  }
  const drop = Math.min(buf.length, total - keep);
  const out = new Float64Array(keep);
  out.set(buf.subarray(drop), 0);
  out.set(block, buf.length - drop);
  return out;
}

const medianOf = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

/* ── 1. SprCore musí být bitově shodný se sprInterp(ltas(…)) ─────────────── */

console.log('\n1. Bezalokační jádro živé cesty musí dávat totéž co měření nahrávky\n');
{
  const sig = tone(220, 4, { vibDepth: 0.03 });
  const core = new SprCore(SR, 4096);
  let worst = 0, n = 0;
  for (let s = 0; s + 4096 <= sig.length; s += 1024) {
    const a = sprInterp(ltas(sig.subarray(s, s + 4096), SR, 4096));
    const b = core.of(sig.subarray(s, s + 4096));
    if (a === a && b === b) { worst = Math.max(worst, Math.abs(a - b)); n++; }
  }
  ok(`SprCore vs sprInterp na ${n} oknech`, worst < 1e-9, `největší rozdíl ${worst.toExponential(1)} dB`);
  ok('měření proběhlo (ne 0 oken)', n > 50, `${n} oken`);

  // sprFrames musí dát totéž, ať počítá přes SprCore nebo přes ltas
  const direct = sprFrames(sig, SR);
  const viaCore = percentile(
    Array.from({ length: Math.floor((sig.length - 4096) / 1024) + 1 },
      (_, i) => core.of(sig.subarray(i * 1024, i * 1024 + 4096))).filter(v => v === v), 0.9);
  ok('sprFrames == totéž přes SprCore', Math.abs(direct - viaCore) < 1e-9,
    `${direct.toFixed(6)} vs ${viaCore.toFixed(6)}`);
}

/* ── 2. Živá cesta vs report (spr_novy_median) ───────────────────────────── */

console.log('\n2. Živá cesta musí sedět s měřením nahrávky (do 1 dB)\n');
{
  /* Referencí je `sprFrames` — přesně ta funkce, ze které analýza nahrávky
   * počítá `spr_novy` u každého tónu. U JEDNOHO drženého tónu nemusí `analyze()`
   * vydat žádné tóny (segmentace potřebuje přechody), takže by se srovnávalo
   * s prázdnem — proto se bere funkce, ne výsledek reportu. Kde report tóny
   * najde, kontroluje se i proti němu. */
  const cases = [
    ['držený 247 Hz, vibrato 3 %', tone(247, 6, { vibDepth: 0.03 })],
    ['držený 330 Hz, vibrato 3 %', tone(330, 6, { vibDepth: 0.03 })],
    ['držený 440 Hz, vibrato 3 %', tone(440, 6, { vibDepth: 0.03 })],
    ['držený 440 Hz, čistý', tone(440, 6)],
  ];
  for (const [label, sig] of cases) {
    // STEJNÁ STATISTIKA NA OBOU STRANÁCH: horní percentil přes okna.
    // Report u jednoho drženého tónu hlásí p90 z oken UVNITŘ tónu, kdežto živý
    // souhrn je medián přes rámce — srovnávat je proti sobě by měřilo rozdíl
    // definic, ne přesnost. Proto se bere p90 na obou stranách.
    const recs = await liveFrames(sig);
    const liveP90 = percentile(recs.map(r => r.sprLast).filter(v => v === v), 0.90);
    // referenční okna na stejných místech, celý signál (ne jen vnitřek tónu)
    const refVals = [];
    const core = new SprCore(SR, 4096);
    for (let s = 0; s + 4096 <= sig.length; s += HOP) refVals.push(core.of(sig.subarray(s, s + 4096)));
    const refP90 = percentile(refVals.filter(v => v === v), 0.90);
    const d = liveP90 - refP90;
    ok(`${label}: živě ${liveP90.toFixed(2)} vs měření nahrávky ${refP90.toFixed(2)} dB`,
      Math.abs(d) <= 0.5, `rozdíl ${d.toFixed(2)} dB`);
  }

  /* Kde report tóny opravdu najde, porovnává se PO TÓNECH, ne přes celou frázi.
   *
   * PROČ: `analyze()` u melodie některé tóny nenajde — je to známá neopravená
   * oktávová chyba YIN (tón 330 Hz vyjde jako 661 Hz a segmentace ho vyřadí).
   * Naměřeno na melodii [196, 247, 294, 330, 392]: report vydal čtyři tóny,
   * tón 330 Hz chyběl. Kdyby se srovnávaly souhrny přes celou frázi, rozdíl
   * ~2 dB by vypadal jako chyba živé metriky, ale ve skutečnosti jde o to, že
   * se srovnávají RŮZNÉ SADY TÓNŮ. Srovnávat se proto musí tentýž tón zvlášť:
   * živé rámce se vezmou z vnitřku tónu, který report sám našel.
   *
   * (Vedlejší nález pro Jana: živá cesta tón 330 Hz změří správně — problém je
   * jen v segmentaci nahrávky.) */
  const parts = [];
  const spans = [];
  let tt = 0;
  for (const f0 of [196, 247, 294, 330, 392]) {
    const dur = 1.4;
    parts.push(tone(f0, dur, { vibDepth: 0.025, seed: 5 + f0 }));
    spans.push([tt, tt + dur, f0]);
    tt += dur;
    const gap = new Float64Array(Math.round(SR * 0.25));
    parts.push(gap); tt += 0.25;
  }
  const mel = new Float64Array(parts.reduce((a, p) => a + p.length, 0));
  { let o = 0; for (const p of parts) { mel.set(p, o); o += p.length; } }

  const res = analyze(mel, SR, { fach: 'tenor' });
  ok('melodie: report našel aspoň tři tóny', res.notes.length >= 3, `tónů ${res.n_notes}`);
  const recs = await liveFrames(mel);
  let worst = 0, compared = 0;
  for (const n of res.notes) {
    if (!Number.isFinite(n.spr_novy)) continue;
    // vnitřek tónu, stejných 80 % jako bere measureNote
    const d = n.t_end - n.t_start;
    const a = n.t_start + 0.2 * d, b = n.t_end - 0.2 * d;
    const inside = recs.filter(r => r.t >= a && r.t <= b && Number.isFinite(r.spr));
    if (inside.length < 5) continue;
    const liveMed = medianOf(inside.map(r => r.spr));
    const diff = Math.abs(liveMed - n.spr_novy);
    worst = Math.max(worst, diff); compared++;
    console.log(`  ${n.note.padEnd(4)} report ${n.spr_novy.toFixed(2)} · živě ${liveMed.toFixed(2)} `
      + `· rozdíl ${(liveMed - n.spr_novy).toFixed(2)} dB`);
  }
  ok('melodie: každý nalezený tón sedí živě i v reportu do 0,5 dB',
    compared >= 3 && worst <= 0.5, `porovnáno ${compared} tónů, největší rozdíl ${worst.toFixed(2)} dB`);
}

/* ── 3. Oprava musí být znát: živá cesta blíž pravdě než staré měřidlo ──── */

console.log('\n3. Na vibratu musí být živá cesta blíž pravdě než staré měřidlo\n');
{
  let sumNew = 0, sumOld = 0, n = 0;
  for (const f0 of [247, 330, 392, 440]) {
    const sig = tone(f0, 6, { vibDepth: 0.03 });
    const truth = trueSPR(f0);
    // STEJNÁ STATISTIKA NA OBOU STRANÁCH (p90 přes okna) — jinak by se
    // srovnávalo měřidlo s jinou definicí a rozdíl by nic neznamenal.
    const recs = await liveFrames(sig);
    const newP90 = percentile(recs.map(r => r.sprLast).filter(v => v === v), 0.90);
    const oldP90 = percentile(recs.map(r => r.sprOld).filter(v => v === v), 0.90);
    const eN = Math.abs(newP90 - truth);
    const eO = Math.abs(oldP90 - truth);
    sumNew += eN; sumOld += eO; n++;
    console.log(`  ${f0} Hz: pravda ${truth.toFixed(2)} — nová cesta ${newP90.toFixed(2)} `
      + `(chyba ${eN.toFixed(2)}), staré měřidlo ${oldP90.toFixed(2)} (chyba ${eO.toFixed(2)})`);
  }
  ok('nová živá cesta je v průměru blíž pravdě než staré měřidlo',
    sumNew / n < sumOld / n, `${(sumNew / n).toFixed(2)} dB vs ${(sumOld / n).toFixed(2)} dB`);
}

/* ── 4. Klouzavé okno SPR musí být krátké (doznívání nesmí utéct) ────────── */

console.log('\n4. Nastavení živé cesty\n');
{
  ok('SPR se měří z okna 4096 (ne 2048)', createLiveState(SR).sprCore.nfft === 4096);
  ok('klouzavé okno SPR je 200 ms', SPR_ROLL_MS === 200, `${SPR_ROLL_MS} ms`);
  const st = createLiveState(SR);
  ok('okno drží právě tolik rámců, kolik odpovídá 200 ms',
    st.sprRollMax === Math.round(SPR_ROLL_MS / BLOCK_MS), `${st.sprRollMax} rámců`);
  ok('SPR okno je delší než rámec pro výšku (jinak by bylo pásmo useknuté)',
    4096 > FRAME_SIZE, `${4096} > ${FRAME_SIZE}`);
}

console.log(`\n═══ PARITA ŽIVĚ ↔ NAHRÁVKA: ${checks - fails}/${checks} v pořádku${fails ? `, ${fails} SELHALO` : ', VŠE SHODNÉ'} ═══\n`);
process.exit(fails ? 1 : 0);
