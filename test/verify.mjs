#!/usr/bin/env node
/**
 * Ověření: dává JS engine stejná čísla jako referenční Python?
 *
 * Načte stejný WAV, prožene ho JS analyzátorem a porovná s report.json
 * z Python verze. Bez tohoto testu by appka mohla tiše lhát.
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyze, REFS } from '../src/analysis.js';

/** Minimální WAV reader (PCM 16/24/32-bit + float32, mono/stereo). */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('není WAV: ' + file);
  }
  let pos = 12, fmt = null, dataOff = null, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = size;
    }
    pos = body + size + (size & 1);
  }
  if (!fmt || dataOff == null) throw new Error('WAV bez fmt/data');

  const { channels, sampleRate, bitsPerSample, audioFormat } = fmt;
  const bytes = bitsPerSample / 8;
  const frames = Math.floor(dataLen / (bytes * channels));
  const out = new Float64Array(frames);

  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const off = dataOff + (i * channels + c) * bytes;
      let v;
      if (audioFormat === 3) {          // IEEE float
        v = buf.readFloatLE(off);
      } else if (bitsPerSample === 16) {
        v = buf.readInt16LE(off) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = buf[off], b1 = buf[off + 1], b2 = buf[off + 2];
        let x = b0 | (b1 << 8) | (b2 << 16);
        if (x & 0x800000) x |= ~0xffffff;
        v = x / 8388608;
      } else if (bitsPerSample === 32) {
        v = buf.readInt32LE(off) / 2147483648;
      } else if (bitsPerSample === 8) {
        v = (buf[off] - 128) / 128;
      } else throw new Error('nepodporovaná bitová hloubka: ' + bitsPerSample);
      sum += v;
    }
    out[i] = sum / channels;
  }
  return { samples: out, sampleRate };
}

function stats(vals) {
  const v = vals.filter(x => x === x).sort((a, b) => a - b);
  if (!v.length) return null;
  const med = v.length & 1 ? v[v.length >> 1] : (v[(v.length >> 1) - 1] + v[v.length >> 1]) / 2;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { n: v.length, med, mean, min: v[0], max: v[v.length - 1] };
}

function fmt(x, d = 2) {
  if (x === null || x === undefined) return '—';
  if (typeof x !== 'number' || x !== x) return '—';
  return x.toFixed(d);
}

const [, , wavFile, pyReport, fach] = process.argv;
if (!wavFile) {
  console.error('použití: node verify.mjs <soubor.wav> [report.json] [fach]');
  process.exit(1);
}

const { samples, sampleRate } = readWav(wavFile);
console.log(`[i] ${path.basename(wavFile)}: ${(samples.length / sampleRate).toFixed(1)} s, ` +
  `${sampleRate} Hz, ${samples.length} vzorků`);

const t0 = Date.now();
const res = analyze(samples, sampleRate, { fach: fach || 'tenor' });
const ms = Date.now() - t0;

console.log(`[i] JS analýza: ${res.n_notes} tónů (vyřazeno ${res.n_dropped}), ${ms} ms`);
console.log(`    tedy ~${(ms / Math.max(1, samples.length / sampleRate)).toFixed(0)} ms ` +
  `na sekundu audia`);

const s = res.summary;
if (s.spr_unusable) {
  console.log(`\n[!] SPR nelze měřit: ${s.reason}`);
} else {
  console.log(`\nJS RING: ${s.notes_with_ring}/${s.n_notes} tónů (${fmt(s.ring_consistency_pct, 1)} %)`);
  console.log(`JS SPR medián: ${fmt(s.spr_median)} dB | SD ${fmt(s.spr_sd)}`);
  console.log(`JS FHE: ${fmt(s.fhe_median, 0)} Hz | F1 naladěno: ${fmt(s.f1_aligned_pct, 1)} %`);
}

// --- srovnání s Python reportem ---
if (pyReport && fs.existsSync(pyReport)) {
  const py = JSON.parse(fs.readFileSync(pyReport, 'utf8'));
  const ps = py.summary;
  console.log('\n═══ SROVNÁNÍ JS vs PYTHON ═══');
  console.log(`${''.padEnd(18)} ${'JS'.padStart(10)} ${'PYTHON'.padStart(10)} ${'rozdíl'.padStart(9)}`);

  const rows = [
    ['SPR medián', s.spr_median, ps.spr_median],
    ['SPR SD', s.spr_sd, ps.spr_sd],
    ['ring %', s.ring_consistency_pct, ps.ring_consistency_pct],
    ['tónů měřitelných', s.n_notes, ps.n_notes],
    ['FHE', s.fhe_median, ps.fhe_median],
    ['F1 naladěno %', s.f1_aligned_pct, ps.f1_aligned_pct],
  ];
  let worstSpr = 0;
  for (const [name, js, py] of rows) {
    const d = (js === null || js === undefined || js !== js ||
      py === null || py === undefined) ? null : js - py;
    if (name === 'SPR medián' && d !== null) worstSpr = Math.abs(d);
    console.log(`${name.padEnd(18)} ${fmt(js).padStart(10)} ${fmt(py).padStart(10)} ` +
      `${(d === null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(2)).padStart(9)}`);
  }

  // Porovnat tóny SPÁROVANÉ PODLE ČASU (ne podle indexu — nástroje segmentují
  // jinak, takže index i v JS ≠ index i v Pythonu).
  const pairs = [];
  for (const a of res.notes) {
    let best = null, bestOv = 0;
    for (const b of py.notes) {
      const ov = Math.min(a.t_end, b.t_end) - Math.max(a.t_start, b.t_start);
      if (ov > bestOv) { bestOv = ov; best = b; }
    }
    // vyžaduj aspoň 50 % překryv kratšího tónu
    const minLen = Math.min(a.t_end - a.t_start, best ? best.t_end - best.t_start : 0);
    if (best && minLen > 0 && bestOv / minLen > 0.5) pairs.push([a, best]);
  }

  if (pairs.length) {
    const f0d = [], centsd = [], sort = [];
    for (const [a, b] of pairs) {
      if (a.f0 === a.f0 && b.f0 === b.f0) {
        f0d.push(Math.abs(a.f0 - b.f0));
        centsd.push(Math.abs(1200 * Math.log2(a.f0 / b.f0)));
      }
      if (a.spr === a.spr && b.spr === b.spr) sort.push(Math.abs(a.spr - b.spr));
    }
    console.log(`\nspárováno podle času: ${pairs.length} tónů ` +
      `(z JS ${res.notes.length}, PY ${py.notes.length})`);
    if (centsd.length) {
      const st = stats(centsd);
      console.log(`  shoda f0: medián ${fmt(st.med, 1)} centů, ` +
        `90. percentil ${fmt(st.max, 1)} centů (max)`);
    }
    if (sort.length) {
      const st = stats(sort);
      console.log(`  shoda SPR: medián ${fmt(st.med, 2)} dB, max ${fmt(st.max, 2)} dB`);
    }
  }

  console.log('\n═══ HODNOCENÍ ═══');
  const ok = worstSpr < 2.0;
  console.log(worstSpr < 0.5 ? `SPR shoda výborná (${worstSpr.toFixed(2)} dB) ✓`
    : worstSpr < 2.0 ? `SPR shoda dobrá (${worstSpr.toFixed(2)} dB) ✓`
      : `SPR shoda NEDOSTATEČNÁ (${worstSpr.toFixed(2)} dB) ✗`);
  process.exitCode = ok ? 0 : 2;
}
