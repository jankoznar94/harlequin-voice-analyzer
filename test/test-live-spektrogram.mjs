#!/usr/bin/env node
/**
 * Testy živého spektrogramu — čistá logika (bez prohlížeče).
 *
 * Testuje se to, co se dá ověřit číslem:
 *   1. historická normalizace (histogram) dá totéž co přesný percentil
 *   2. sloupec má energii tam, kde má být (kmitočet → správný řádek obrazu)
 *   3. normalizace se v prvních sekundách chová podle měření (pevná → percentil)
 *   4. statistika sloupce se bere ze VZORKU ŘÁDKŮ, ne z vrcholu
 *      (to je ta past, která měřila o 8,8 dB jinde)
 *   5. cena za sloupec se vejde do rozpočtu živého rámce
 *
 * Použití: node test/test-live-spektrogram.mjs
 */
import {
  createSpecState, specColumn, feedSpec, createHistogram, histAdd, histQuantile,
  SPEC_NFFT, SPEC_STAT_STEP, SPEC_MAX_HZ, SPEC_WARMUP_DB, SPEC_HIST_BUCKET,
} from '../src/live-spec.js';

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

const SR = 48000;
const ROWS = 192;

/** Vyrobí okno délky `n` se sinusem daného kmitočtu a amplitudy. */
function tone(f, n = SPEC_NFFT, amp = 0.5, sr = SR) {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr);
  return x;
}

console.log('\n══ 1) histogram vs. přesný percentil ══\n');
{
  const vals = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 20000; i++) vals.push(-60 + rnd() * 90);
  const h = createHistogram();
  for (const v of vals) histAdd(h, v);
  const exact = (q) => { const s = [...vals].sort((a, b) => a - b); return s[Math.floor(s.length * q)]; };
  for (const q of [0.5, 0.9, 0.995]) {
    const hv = histQuantile(h, q);
    const ex = exact(q);
    ok(`percentil ${q} z histogramu ≈ přesný`, Math.abs(hv - ex) <= SPEC_HIST_BUCKET,
      `${hv.toFixed(2)} vs ${ex.toFixed(2)} (přihrádka ${SPEC_HIST_BUCKET})`);
  }
  const empty = createHistogram();
  ok('prázdný histogram vrací NaN (volající pozná, že není z čeho normalizovat)',
    Number.isNaN(histQuantile(empty)));
  // hodnoty mimo rozsah se přiříznou, ne zahodí
  const h2 = createHistogram();
  histAdd(h2, -9999); histAdd(h2, 9999);
  ok('hodnoty mimo rozsah se přiříznou na okraj (nezmizí)', h2.total === 2);
}

console.log('\n══ 2) sloupec: kmitočet sedí na správném řádku ══\n');
{
  const st = createSpecState(SR, ROWS);
  const col = specColumn(st, tone(3000));
  ok('sloupec má plný počet řádků', col && col.length === ROWS, `${col?.length}`);

  const peakRow = col.indexOf(Math.max(...col));
  // 3 kHz při maxHz 6 kHz a 192 řádcích → horní polovina obrazu
  const expected = Math.round((1 - 3000 / SPEC_MAX_HZ) * ROWS);
  ok('vrchol 3 kHz je tam, kde geometrie říká', Math.abs(peakRow - expected) <= 2,
    `řádek ${peakRow}, čekáno ~${expected}`);

  // dva různé kmitočty musí skončit na různých řádcích
  const st2 = createSpecState(SR, ROWS);
  const low = specColumn(st2, tone(400)).indexOf(Math.max(...specColumn(st2, tone(400))));
  const st3 = createSpecState(SR, ROWS);
  const high = specColumn(st3, tone(5000)).indexOf(Math.max(...specColumn(st3, tone(5000))));
  ok('400 Hz leží pod 5 kHz', low > high, `400 Hz řádek ${low}, 5 kHz řádek ${high}`);

  // okno kratší než NFFT se odmítne — nedopočítává se z nul
  const st4 = createSpecState(SR, ROWS);
  ok('krátké okno se odmítne (nedopočítává se z nul)',
    specColumn(st4, new Float64Array(SPEC_NFFT - 1)) === null);

  // vzorkovací kmitočet mimo 48 kHz: mapa řádků se musí přepočítat
  //
  // ⚠️ Když je nejvyšší bin POD zobrazeným pásmem (při 8 kHz je 4 kHz na
  // Nyquistu, ale obraz sahá do 6 kHz), zbytek obrazu nad ním žádný bin nemá
  // a mapuje se na poslední — takže energie 1 kHz skončí výš, než by člověk
  // čekal z prostého poměru 1 kHz / 6 kHz. Test proto počítá s KOLEČKEM
  // (maxBin), ne s pásmem: jinak by hlásil chybu tam, kde je chování správné.
  const st8 = createSpecState(8000, ROWS);
  const col8 = specColumn(st8, tone(1000, SPEC_NFFT, 0.5, 8000));
  const pr8 = col8.indexOf(Math.max(...col8));
  const exp8 = Math.round((1 - st8.maxBin / st8.maxBin) * ROWS);   // horní okraj
  const bin8 = Math.round(1000 / st8.binHz);
  const exp8byBin = Math.round((1 - bin8 / st8.maxBin) * ROWS);
  ok('při 8 kHz sedí 1 kHz tam, kam ho mapa binů posílá',
    Math.abs(pr8 - exp8byBin) <= 2,
    `řádek ${pr8}, podle binu ${exp8byBin} (bin ${st8.binHz.toFixed(1)} Hz, maxBin ${st8.maxBin}, okraj ${exp8})`);
}

console.log('\n══ 3) normalizace: vzorek řádků, ne vrchol sloupce ══\n');
{
  /*
   * Past, na kterou jsem napoprvé naletěla: kdyby se do statistiky dával
   * VRCHOL sloupce, vyšel by percentil výš než pravda a obraz by byl tmavý.
   *
   * ⚠️ Signál musí mít v čase MĚNÍCÍ SE ÚROVEŇ, jinak test nic nezměří:
   * se stálým signálem vyjde vrchol sloupce = percentil pixelů a test projde
   * i s chybnou statistikou (naměřeno — s plochým signálem byl rozdíl 0,5 dB,
   * s kolísajícím 4,0 dB).
   */
  const st = createSpecState(SR, ROWS);
  const pixels = [], peaks = [], sampled = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let f = 0; f < 400; f++) {
    const lvl = Math.pow(10, (-12 + 24 * rnd()) / 20);
    const x = new Float64Array(SPEC_NFFT);
    for (let i = 0; i < SPEC_NFFT; i++) {
      let s = 0;
      for (const hz of [220, 330, 660, 1320, 2640, 3520]) s += Math.sin(2 * Math.PI * hz * i / SR) * 0.3;
      x[i] = (s * 0.3 + 0.5 * (rnd() - 0.5)) * lvl;
    }
    const col = specColumn(st, x);
    let pk = -Infinity;
    for (let r = 0; r < ROWS; r++) {
      pixels.push(col[r]);
      if (col[r] > pk) pk = col[r];
      if (r % SPEC_STAT_STEP === 0) sampled.push(col[r]);
    }
    peaks.push(pk);
  }
  const p995 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.995)]; };
  const truth = p995(pixels);
  const byPeak = p995(peaks);
  const bySample = p995(sampled);
  ok('percentil ze vzorku řádků je blíž pravdě než percentil z vrcholů',
    Math.abs(bySample - truth) < Math.abs(byPeak - truth),
    `vzorek ${bySample.toFixed(2)} (Δ ${(bySample - truth).toFixed(2)}) · ` +
    `vrcholy ${byPeak.toFixed(2)} (Δ ${(byPeak - truth).toFixed(2)}) · pravda ${truth.toFixed(2)}`);
  ok('vrcholy jsou skutečně vychýlené výš (past je reálná, ne teoretická)',
    byPeak - truth > 2, `${(byPeak - truth).toFixed(2)} dB`);
  ok('percentil ze vzorku se od pravdy liší nejvýš o 1,5 dB',
    Math.abs(bySample - truth) <= 1.5, `${Math.abs(bySample - truth).toFixed(2)} dB`);
}

console.log('\n══ 4) zahřátí: pevná hodnota → percentil ══\n');
{
  const st = createSpecState(SR, ROWS);
  const win = tone(440, SPEC_NFFT, 0.4);
  const norms = [];
  let first = null;
  for (let i = 0; i < 300; i++) {                        // 300 rámců = 6 s
    const r = feedSpec(st, win);
    if (!first) first = r;
    norms.push(r.norm);
  }
  ok('první sloupec se normuje pevnou hodnotou', norms[0] === SPEC_WARMUP_DB, `${norms[0]}`);
  ok('první sloupec je označený jako „zahřívání“', first.warm === true);
  const warmFrames = Math.round(2 * 50);
  ok('po 2 s už je norm podle percentilu (ne pevná hodnota)',
    Math.abs(norms[warmFrames + 30] - SPEC_WARMUP_DB) > 0.1,
    `norm ${norms[warmFrames + 30].toFixed(2)}`);
  // přechod nesmí skočit: mezi sousedními rámci se norm změní jen málo
  let maxJump = 0;
  for (let i = 1; i < norms.length; i++) maxJump = Math.max(maxJump, Math.abs(norms[i] - norms[i - 1]));
  ok('přechod na percentil není skok (žádné cuknutí jasem)', maxJump < 2.5, `největší skok ${maxJump.toFixed(2)} dB`);
  // norm se ustálí na percentilu z histogramu
  const h = histQuantile(st.hist, 0.995);
  ok('norm po ustálení odpovídá percentilu z histogramu',
    Math.abs(norms[norms.length - 1] - h) < 0.01, `${norms[norms.length - 1].toFixed(2)} vs ${h.toFixed(2)}`);
  ok('sloupec se s každým rámcem posune (kresba pozná nový obsah)', st.seq === 300, `${st.seq}`);
}

console.log('\n══ 5) cena a stabilita ══\n');
{
  const st = createSpecState(SR, ROWS);
  const win = tone(440, SPEC_NFFT, 0.5);
  for (let i = 0; i < 200; i++) feedSpec(st, win);        // zahřátí
  const t0 = performance.now();
  const N = 2000;
  for (let i = 0; i < N; i++) feedSpec(st, win);
  const ms = (performance.now() - t0) / N;
  ok('sloupec se vejde do 3 % rozpočtu rámce (20 ms)', ms * 100 / 20 < 3,
    `${ms.toFixed(3)} ms/rámec = ${(ms * 100 / 20).toFixed(2)} %`);

  // histogram nesmí růst donekonečna — při dlouhém sezení musí zůstat malý
  const st2 = createSpecState(SR, ROWS);
  for (let i = 0; i < 60 * 50 * 10; i++) feedSpec(st2, win);   // 10 minut
  ok('histogram neroste (drží se jen počty v přihrádkách)',
    st2.hist.bins.length <= 1200, `${st2.hist.bins.length} přihrádek, ${st2.hist.total} hodnot`);
  ok('po 10 minutách je norm stále konečné číslo', Number.isFinite(st2.norm), `${st2.norm.toFixed(1)}`);
}

console.log(`\n${fails ? '✗' : '✓'} ${checks - fails}/${checks} kontrol prošlo\n`);
process.exit(fails ? 1 : 0);
