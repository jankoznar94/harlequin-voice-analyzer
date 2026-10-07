#!/usr/bin/env node
/**
 * ŠLA BY DÉLKA TRAKTU MĚŘIT ŽIVĚ? Ověření CELÉ ŽIVÉ CESTY, ne jen vzorce.
 *
 * Tři věci, které musí platit, aby se číslo dalo ukázat:
 *   1. PŘESNOST — proti ZNÁMÉ PRAVDĚ (syntetický tón s předepsaným traktem).
 *      Živý režim tón nezná, takže se měří přesně to, co uvidí zpěvák: rámce
 *      jdou po BLOCK_MS, dokud tón drží; bere se poslední číslo od začátku tónu.
 *   2. SHODA S REPORTEM — na reálné nahrávce musí živé číslo sedět s tím, co
 *      z TÉHOŽ tónu vyjde offline (jinak by indikátor ukazoval druhé měřidlo).
 *   3. PRAH — z jednoho okna se číslo ukázat NESMÍ (kolísá o ±1 cm).
 *
 * Cesta je SKUTEČNÁ: `feedFrame` + `createDsp` + `pushBlock` vytažený ze
 * `live-run.js`. Kdyby se sem dosadil vlastní opis, test by hlídal opis.
 */
import path from 'node:path';
import fs from 'node:fs';
import { feedFrame, createLiveState, summarizeLive, BLOCK_MS, FRAME_SIZE, VTL_MIN_WINDOWS } from '../src/live.js';
import { createDsp } from '../src/dsp-backend.js';
import { analyze, formantsAt, noteTraktu } from '../src/analysis.js';

const ROOT = path.join(import.meta.dirname, '..');
const WASM = path.join(ROOT, 'wasm', 'build', 'dsp.wasm');
const SR = 48000;
const BLOCK = Math.round(SR * BLOCK_MS / 1000);      // 960

let fails = 0, checks = 0;
const ok = (label, cond, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
};

/* ── `pushBlock` ze SKUTEČNÉHO live-run.js (není exportovaný) ──────────────
 *
 * POZOR: `pushBlock` sahá i na konstanty spektrogramu (`SPEC_BUF_SAMPLES`,
 * `SPEC_NFFT`) — když se sem nepředají, spadne to na `ReferenceError`
 * a test hlásí chybu kódu, která vznikla v testu. Přesně to se stalo při
 * zavedení živého spektrogramu: test padal od v37, protože seznamy
 * závislostí se musí hlídat spolu s kódem.
 */
const src = fs.readFileSync(path.join(ROOT, 'src/live-run.js'), 'utf8');
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`funkce ${name} nenalezena`);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('nevyvážené závorky');
};
const { SPEC_BUF_SAMPLES, SPEC_NFFT, createSpecState, feedSpec } =
  await import('../src/live-spec.js');
const factory = new Function('feedFrame', 'onFrame', 'SPR_NFFT', 'FRAME_SIZE', 'BLOCK_MS',
  'SPEC_BUF_SAMPLES', 'SPEC_NFFT', 'createSpecState', 'feedSpec',
  grab('pushBlock') + '\n' + grab('appendKeep') + '\nreturn { pushBlock };');
const { pushBlock } = factory(feedFrame, () => {}, 4096, FRAME_SIZE, BLOCK_MS,
  SPEC_BUF_SAMPLES, SPEC_NFFT, createSpecState, feedSpec);

/* ── syntetický hlas se ZNÁMOU délkou traktu ─────────────────────────────── */
const PRAVDA_F = [500, 1500, 2500];
const PRAVDA = 34300 / (2 * 1000);           // 17,15 cm
function ton(f0, sek, vib = 0) {
  const n = Math.round(sek * SR);
  const o = new Float64Array(n);
  const g = (f) => {
    const r = (fc, bw, a) => a / (1 + ((f - fc) / bw) ** 2);
    return r(PRAVDA_F[0], 120, 1.0) + r(PRAVDA_F[1], 180, 0.45) + r(PRAVDA_F[2], 220, 0.30)
         + r(3000, 250, 0.22) + r(3500, 300, 0.10);
  };
  let fi = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = vib ? f0 * Math.pow(2, (vib / 100) * Math.sin(2 * Math.PI * 5.5 * t) / 12) : f0;
    fi += 2 * Math.PI * f / SR;
    let s = 0;
    for (let h = 1; h * f0 < 6000; h++) s += (g(h * f0) / h) * Math.sin(h * fi);
    o[i] = 0.25 * s * Math.min(1, i / 1200) * Math.min(1, (n - i) / 1200);
  }
  return o;
}

/** Prožene vzorky živou cestou po blocích a vrátí stav. */
async function zive(samples, { backend } = {}) {
  const dsp = await createDsp({ frameSize: FRAME_SIZE, sampleRate: SR, fach: 'tenor', force: backend });
  const state = createLiveState(SR, FRAME_SIZE);
  /* ⚠️ Musí tu být VŠE, na co `pushBlock` sahá — včetně zásobníku
   * spektrogramu (`specBuf`) a stavu jeho sloupců (`specState`). Když se
   * pole přidá do kódu a ne sem, test spadne na `undefined.length`
   * a hlásí vadu, která vznikla v testu (stalo se při zavedení
   * živého spektrogramu). */
  const r = {
    state, backend: dsp,
    pending: new Float64Array(0),
    sprBuf: new Float64Array(0),
    specBuf: new Float64Array(0),
    specState: null,
    specRows: 192,
  };
  for (let i = 0; i + BLOCK <= samples.length; i += BLOCK) {
    pushBlock(r, samples.subarray(i, i + BLOCK));
  }
  return state;
}

/* ══ 1. PŘESNOST PROTI ZNÁMÉ PRAVDĚ ═══════════════════════════════════════ */
console.log('\n═══ 1. Přesnost živé cesty proti známé pravdě ═══');
{
  const chyby = [];
  for (const f0 of [110, 131, 147, 175, 247, 262]) {
    for (const vib of [0, 5]) {
      const state = await zive(ton(f0, 2.5, vib));
      const s = summarizeLive(state);
      const e = s.vtlCm - PRAVDA;
      if (Number.isFinite(s.vtlCm)) chyby.push(Math.abs(e));
      console.log(`    f0 ${String(f0).padStart(4)} Hz${vib ? ', vib 5 %' : '         '}  ` +
        `${Number.isFinite(s.vtlCm) ? s.vtlCm.toFixed(2) + ' cm' : '—'}  z ${s.vtlN} tónů  ` +
        (Number.isFinite(s.vtlCm) ? `chyba ${e >= 0 ? '+' : '−'}${Math.abs(e).toFixed(2)} cm` : ''));
    }
  }
  const a = chyby.sort((x, y) => x - y);
  ok('aspoň 8 z 12 tónů dá číslo', chyby.length >= 8, `${chyby.length}/12`);
  ok('|chyba| medián do 0,6 cm', a.length && a[a.length >> 1] < 0.6,
    a.length ? `${a[a.length >> 1].toFixed(2)} cm` : '—');
  ok('|chyba| max do 1,2 cm', a.length && a[a.length - 1] < 1.2,
    a.length ? `${a[a.length - 1].toFixed(2)} cm` : '—');
}

/* ══ 2. SHODA S REPORTEM NA REÁLNÉ NAHRÁVCE ════════════════════════════════ */
console.log('\n═══ 2. Shoda živého čísla s offline reportem (stejný tón) ═══');
{
  // Tóny vyříznuté z reálné nahrávky, aby šlo porovnat TOTÉŽ. Vezmou se
  // VŠECHNY, které offline číslo vůbec dají — na zpev3x.wav jsou tři.
  const wav = process.env.HOME + '/.cache/vaud-test/zpev3x.wav';
  let srovnano = 0; const shoda = [];
  if (fs.existsSync(wav)) {
    const b = fs.readFileSync(wav);
    let o = 12, fmt = null, dOff = 0, dLen = 0;
    while (o < b.length - 8) {
      const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4);
      if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
      if (id === 'data') { dOff = o + 8; dLen = sz; }
      o += 8 + sz + (sz & 1);
    }
    const by = fmt.bits / 8;
    const n = Math.floor(Math.min(dLen, b.length - dOff) / (by * fmt.ch));
    const smp = new Float64Array(n);
    for (let i = 0; i < n; i++) smp[i] = fmt.bits === 16 ? b.readInt16LE(dOff + i * by * fmt.ch) / 32768 : b.readFloatLE(dOff + i * by * fmt.ch);

    const res = analyze(smp, SR, { fach: 'tenor' });
    const ref = res.notes.filter(nt => noteTraktu(nt.f1, nt.f2, nt.f3) && nt.dur >= 1.0);
    for (const nt of ref) {
      const i0 = Math.round(nt.t_start * SR);
      const i1 = Math.round(Math.min(nt.t_end * SR, i0 + 3 * SR));
      const state = await zive(smp.subarray(i0, i1));
      const s = summarizeLive(state);
      const off = noteTraktu(nt.f1, nt.f2, nt.f3).vtl_cm;
      if (!Number.isFinite(s.vtlCm)) { console.log(`    ${nt.note}: živě — (okna neprošla filtrem)`); continue; }
      srovnano++; shoda.push(Math.abs(s.vtlCm - off));
      console.log(`    ${String(nt.note).padEnd(4)} živě ${s.vtlCm.toFixed(2)} cm  offline ${off.toFixed(2)} cm  rozdíl ${Math.abs(s.vtlCm - off).toFixed(2)} cm  (z ${s.vtlN} tónů)`);
    }
  }
  ok('aspoň jeden tón z reálné nahrávky se dal srovnat', srovnano >= 1, `${srovnano} tónů`);
  const ch = shoda.sort((a, b) => a - b);
  ok('shoda s offline do 1,0 cm', ch.length && ch[ch.length >> 1] < 1.0,
    ch.length ? `medián ${ch[ch.length >> 1].toFixed(2)} cm` : '—');
}

/* ══ 3. PRAH: z jednoho okna se číslo ukázat nesmí ═════════════════════════ */
console.log('\n═══ 3. Práh: jeden tón (málo oken) se nehlásí ═══');
{
  // Krátký tón — okna sotva nad VTL_WIN, takže se nesmí stát „měřením“.
  const kratky = ton(146.83, 0.10);            // 100 ms: okno 85 ms se ani nenaplní
  const state = await zive(kratky);
  const s = summarizeLive(state);
  ok('z 0,1 s tónu se číslo NEHLÁSÍ', !Number.isFinite(s.vtlCm), `vtlN=${s.vtlN}`);

  // Naopak dost dlouhý tón hlásit musí.
  const dlouhy = ton(146.83, 2.5);
  const s2 = summarizeLive(await zive(dlouhy));
  ok('z 2,5 s tónu se číslo HLÁSÍ', Number.isFinite(s2.vtlCm), `${s2.vtlCm?.toFixed(2)} cm`);

  // Práh je opravdu použitý, ne jen dekorace v kódu. Bere se VTL_MIN_WINDOWS-1
  // oken, aby test platil i kdyby se konstanta později změnila.
  const state3 = createLiveState(SR, FRAME_SIZE);
  const pod = Array.from({ length: VTL_MIN_WINDOWS - 1 }, (_, i) => 17.2 + i * 0.1);
  state3.vtlValues = pod.slice();
  state3.vtlTones = [];
  const s3 = summarizeLive(state3);
  ok(`${pod.length} oken (pod prahem ${VTL_MIN_WINDOWS}) se do souhrnu nepočítá`, !Number.isFinite(s3.vtlCm), `vtlN=${s3.vtlN}`);

  // Naopak přesně na prahu se počítat MUSÍ — jinak by hranice utekla o jedna.
  const state4 = createLiveState(SR, FRAME_SIZE);
  state4.vtlValues = Array.from({ length: VTL_MIN_WINDOWS }, (_, i) => 17.2 + i * 0.1);
  state4.vtlTones = [];
  const s4 = summarizeLive(state4);
  ok(`přesně ${VTL_MIN_WINDOWS} okna (na prahu) se počítají`, Number.isFinite(s4.vtlCm), `${s4.vtlCm?.toFixed(2)} cm`);
}

/* ══ 4. Záporná kontrola: bez filtru by číslo vyšlo i z harmonické ════════ */
console.log('\n═══ 4. Fyziologický filtr se skutečně používá ═══');
{
  // Tón, kde LPC chytne harmonickou (dF mimo fyziologii) — číslo se nesmí objevit.
  const spatny = ton(220, 2.5);               // naměřeno: dF 557 Hz → mimo rozsah
  const F = formantsAt(spatny, SR, 0, 4096);
  const t = noteTraktu(F[0], F[1], F[2]);
  ok('kontrolní tón má opravdu dF mimo fyziologii', t === null,
    F.length ? `F1–F3 = ${F.slice(0, 3).map(x => Math.round(x)).join(', ')}` : '—');
  const s = summarizeLive(await zive(spatny));
  ok('takový tón číslo nedá', !Number.isFinite(s.vtlCm));
}

console.log(`\n═══ ${checks - fails} prošlo, ${fails} selhalo ═══\n`);
process.exitCode = fails ? 1 : 0;
