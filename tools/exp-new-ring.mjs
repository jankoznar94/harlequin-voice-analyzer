/**
 * Návrh nového vyhodnocení:
 *  1) „vyrovnanost" = kolik tónů se neodchyluje od VLASTNÍHO mediánu (jádro metody)
 *  2) absolutní srovnání s literaturou zvlášť (ne jako „správně/špatně")
 *  3) vyloučit tóny, kde SPR nic neznamená (příliš tiché / příliš krátké)
 * Ověřuje, že výsledek není citlivý na volbu prahů.
 */
import { readFileSync } from 'node:fs';
import { analyze } from '../src/analysis.js';

function loadWav(p) {
  const b = readFileSync(p);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(body + 2), sr: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = b.subarray(body, body + sz);
    off = body + sz + (sz & 1);
  }
  const N = Math.floor(data.length / (fmt.ch * fmt.bits / 8));
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let a = 0;
    for (let c = 0; c < fmt.ch; c++) a += data.readInt16LE((i * fmt.ch + c) * (fmt.bits / 8)) / 32768;
    x[i] = a / fmt.ch;
  }
  return { samples: x, sampleRate: fmt.sr };
}

function median(v) { const s = [...v].sort((a, b) => a - b); return s.length ? (s.length & 1 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2) : NaN; }

function summarise(notes, { minDur = 0.30, splDrop = 20, k = 3.0 } = {}) {
  const all = notes.filter(n => n.spr === n.spr);
  const medSpl = median(all.map(n => n.spl_dbfs));
  const usable = all.filter(n => n.dur >= minDur && n.spl_dbfs >= medSpl - splDrop);
  const spr = usable.map(n => n.spr);
  const med = median(spr);
  const dev = spr.map(v => Math.abs(v - med));
  const mad = median(dev);
  const cutoff = med - Math.max(k, 3.0 * 1.4826 * mad);
  const dropouts = usable.filter(n => n.spr < cutoff);
  const stable = usable.length - dropouts.length;
  const above20 = usable.filter(n => n.spr >= -20).length;
  return {
    celkem: notes.length, pouzite: usable.length,
    vyrazeno: notes.length - usable.length,
    med: +med.toFixed(2), mad: +mad.toFixed(2), cutoff: +cutoff.toFixed(2),
    vyrovnanost: +(100 * stable / usable.length).toFixed(1),
    nad_20db: +(100 * above20 / usable.length).toFixed(1),
    vypadky: dropouts.map(n => `${n.note}@${n.t_start.toFixed(0)}s`),
  };
}

const files = process.argv.slice(2);
for (const f of files) {
  const { samples, sampleRate } = loadWav(f);
  const res = analyze(samples, sampleRate, { fach: 'tenor' });
  console.log(`\n═══ ${f.split('/').slice(-2).join('/')} — ${res.notes.length} tónů ═══`);
  console.log('nastavení        použito  vyřazeno | vyrovnanost | nad −20 dB | medián | cutoff');
  for (const [name, opt] of [
    ['výchozí', {}],
    ['minDur 0,25 / spl 25', { minDur: 0.25, splDrop: 25 }],
    ['minDur 0,30 / spl 20', { minDur: 0.30, splDrop: 20 }],
    ['minDur 0,35 / spl 15', { minDur: 0.35, splDrop: 15 }],
    ['minDur 0,40 / spl 12', { minDur: 0.40, splDrop: 12 }],
    ['k = 2,5', { k: 2.5 }],
    ['k = 4,0', { k: 4.0 }],
  ]) {
    const s = summarise(res.notes, opt);
    console.log(`${name.padEnd(21)} ${String(s.pouzite).padStart(5)}  ${String(s.vyrazeno).padStart(7)} | ${String(s.vyrovnanost).padStart(10)} % | ${String(s.nad_20db).padStart(9)} % | ${String(s.med).padStart(6)} | ${String(s.cutoff).padStart(7)}`);
  }
  const s = summarise(res.notes, {});
  console.log(`výchozí výpadky (${s.vypadky.length}): ${s.vypadky.join(', ')}`);
  console.log(`starý výstup appky: ring ${res.summary.ring_consistency_pct.toFixed(1)} %, medián ${res.summary.spr_median.toFixed(2)} dB`);
}
