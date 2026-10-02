#!/usr/bin/env node
/**
 * Test celé pipeline aplikace v Node (bez prohlížeče).
 *
 * Simuluje to, co dělá app.js: načte WAV → analyze() → sestaví markdown.
 * Ověřuje, že všechny exporty existují, nic nehází a výstup dává smysl.
 * Chytá chyby, které by se jinak projevily až v prohlížeči.
 */
import fs from 'node:fs';
import { analyze, REFS, czPlural } from '../src/analysis.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

function readWav(file) {
  const buf = fs.readFileSync(file);
  let pos = 12, fmt = null, dataOff = null, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') fmt = {
      audioFormat: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2),
      sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14),
    };
    else if (id === 'data') { dataOff = body; dataLen = size; }
    pos = body + size + (size & 1);
  }
  const { channels, sampleRate, bitsPerSample, audioFormat } = fmt;
  const bytes = bitsPerSample / 8;
  const frames = Math.floor(dataLen / (bytes * channels));
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const off = dataOff + (i * channels + c) * bytes;
      let v;
      if (audioFormat === 3) v = buf.readFloatLE(off);
      else if (bitsPerSample === 16) v = buf.readInt16LE(off) / 32768;
      else if (bitsPerSample === 32) v = buf.readInt32LE(off) / 2147483648;
      else throw new Error('bitová hloubka ' + bitsPerSample);
      sum += v;
    }
    out[i] = sum / channels;
  }
  return { samples: out, sampleRate };
}

console.log('\n═══ Test celé pipeline (jako v prohlížeči) ═══\n');

const src = process.argv[2] || '/tmp/amor.wav';
if (!fs.existsSync(src)) {
  console.log(`  (přeskočeno — chybí ${src})`);
  process.exit(0);
}

const { samples, sampleRate } = readWav(src);
console.log(`[i] ${src}: ${(samples.length / sampleRate).toFixed(1)} s @ ${sampleRate} Hz\n`);

// 1) exporty existují
check('REFS obsahuje referenční hodnoty', !!(REFS.SPR && REFS.FHE.tenor));
check('czPlural skloňuje', czPlural(1, 'tón', 'tóny', 'tónů') === 'tón'
  && czPlural(3, 'tón', 'tóny', 'tónů') === 'tóny'
  && czPlural(9, 'tón', 'tóny', 'tónů') === 'tónů');

// 2) analýza proběhne
const t0 = Date.now();
const res = analyze(samples, sampleRate, { fach: 'tenor' });
const ms = Date.now() - t0;
check('analýza proběhla bez výjimky', true, `${ms} ms`);
check('výsledek má tóny', res.notes.length > 0, `${res.notes.length} tónů`);
check('summary má všechna pole',
  res.summary && 'ring_consistency_pct' in res.summary && 'spr_median' in res.summary);

// 3) každý tón má konzistentní data
let badNote = null;
for (const n of res.notes) {
  const keys = ['idx', 't_start', 't_end', 'dur', 'note', 'f0', 'spr', 'f1', 'f2',
    'spr_valid', 'ring_ok', 'f1_tuning_relevant'];
  for (const k of keys) {
    if (!(k in n)) { badNote = `${k} chybí u tónu ${n.idx}`; break; }
  }
  if (badNote) break;
  if (!(n.t_end > n.t_start)) { badNote = `tón ${n.idx} má neplatný čas`; break; }
  if (n.note === '?' || n.note === undefined) { badNote = `tón ${n.idx} bez noty`; break; }
}
check('všechny tóny mají konzistentní data', !badNote, badNote || '');

// 4) součet ring/nering sedí
const s = res.summary;
if (!s.spr_unusable) {
  const counted = res.notes.filter(n => n.spr_valid && n.spr === n.spr).length;
  check('n_notes odpovídá měřitelným tónům', counted === s.n_notes,
    `${counted} vs ${s.n_notes}`);
  check('ring + výpadky = měřitelné', s.notes_with_ring + s.notes_missing_ring === s.n_notes,
    `${s.notes_with_ring}+${s.notes_missing_ring} vs ${s.n_notes}`);
  check('ring je 0-100 %', s.ring_consistency_pct >= 0 && s.ring_consistency_pct <= 100,
    s.ring_consistency_pct.toFixed(1) + ' %');
  check('SPR min <= medián <= max',
    s.spr_min <= s.spr_median && s.spr_median <= s.spr_max);
}

// 5) markdown se sestaví (jako v app.js)
function markdown(r) {
  const L = [`# Analýza`, ''];
  L.push(`## Ring konzistence`);
  L.push(`- Tónů s ringem: ${r.summary.notes_with_ring}/${r.summary.n_notes}`);
  L.push('', '| # | tón | SPR dB | ring |', '|---|---|---|---|');
  for (const n of r.notes) {
    L.push(`| ${n.idx} | ${n.note} | ${n.spr === n.spr ? n.spr.toFixed(1) : '—'} | ` +
      `${n.ring_ok ? 'ANO' : 'NE'} |`);
  }
  return L.join('\n');
}
let md = null;
try { md = markdown(res); } catch (e) { md = null; }
check('markdown se sestaví', md && md.includes('| # |'), md ? '' : 'vyhodilo chybu');
check('markdown neobsahuje NaN', md && !md.includes('NaN'),
  md && md.includes('NaN') ? 'obsahuje NaN!' : '');

// 6) JSON je platný a bez NaN
let json = null;
try {
  json = JSON.stringify(res, (k, v) => (v === undefined ? null : v), 2);
  JSON.parse(json);
} catch (e) { json = null; }
check('JSON je platný', json !== null);
check('JSON neobsahuje NaN', json && !/\bNaN\b/.test(json),
  json && /\bNaN\b/.test(json) ? 'obsahuje NaN!' : '');

console.log(`\n═══ ${pass} prošlo, ${fail} selhalo ═══`);
if (fail) {
  console.log('\nVÝSTUP JE NEPLATNÝ — appka by v prohlížeči selhala.');
}
process.exitCode = fail ? 1 : 0;
