#!/usr/bin/env node
/**
 * EXPERIMENT 4: dá se VTL měřit ŽIVĚ se STEJNÝM číslem jako u nahrávky?
 *
 * Předchozí pokus (exp-vtl-live2) měřil okna s krokem 100 ms a porovnával je
 * proti offline tónu — a vyšlo 0 %. To ale nebyl nález o metrice: `formantsAt`
 * je LPC Burg se STŘEDOVÁNÍM okna 30 ms a krokem 10 ms, takže na okně 171 ms
 * se spočítá sotva pět rámců a medián z pěti rámců není medián. Offline tón
 * 1,3 s má rámců šedesát.
 *
 * Tady se proto okno posouvá PO RÁMCÍCH (krok 10 ms) a hledá se odpověď na
 * tři různé otázky:
 *   1. jaké okno už dá totéž co offline (stabilita proti délce tónu),
 *   2. kolik tónů přežije fyziologický filtr (výtěžnost),
 *   3. kolik to stojí času (rozpočet živého indikátoru je ~0,4 ms/rámec 20 ms).
 *
 * Používá SKUTEČNÝ `formantsAt` a SKUTEČNÝ offline výsledek `analyze()`.
 * Použití: node tools/exp-vtl-live4.mjs [soubor.wav]
 */
import fs from 'node:fs';
import { analyze, formantsAt } from '../src/analysis.js';

function loadWav(p) {
  const b = fs.readFileSync(p);
  let o = 12, fmt = null, dOff = 0, dLen = 0;
  while (o < b.length - 8) {
    const id = b.toString('ascii', o, o + 4);
    const sz = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') { dOff = o + 8; dLen = sz; }
    o += 8 + sz + (sz & 1);
  }
  const by = fmt.bits / 8;
  const n = Math.floor(Math.min(dLen, b.length - dOff) / (by * fmt.ch));
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = fmt.bits === 16 ? b.readInt16LE(dOff + i * by * fmt.ch) / 32768 : b.readFloatLE(dOff + i * by * fmt.ch);
  return { samples: s, sampleRate: fmt.sr };
}

const wav = process.argv.find(a => a.endsWith('.wav')) || process.env.HOME + '/.cache/vaud-test/zpev3x.wav';
const { samples, sampleRate } = loadWav(wav);
const D3 = (F) => {
  const v = F.slice(0, 3).filter(x => x === x && x > 0);
  if (v.length < 2) return NaN;
  const r = [];
  for (let i = 1; i < v.length; i++) r.push(v[i] - v[i - 1]);
  return r.reduce((a, b) => a + b, 0) / r.length;
};
const PHY = (d) => d >= 780 && d <= 1429;

/* ── reference: všechny tóny, kde offline filtr projde (na celý tón) ────── */
const res = analyze(samples, sampleRate, { fach: 'tenor' });
const noty = res.notes.filter(n => n.dur >= 0.8 && PHY(D3([n.f1, n.f2, n.f3])));
console.log(`\nSoubor: ${wav.split('/').pop()}  ${sampleRate} Hz, ${(samples.length / sampleRate).toFixed(0)} s`);
console.log(`Offline: ${res.notes.length} tónů, VTL ${res.summary.vtl_cm.toFixed(1)} cm z ${res.summary.vtl_n} tónů`);
console.log(`Referenčních tónů (dur >= 0,8 s a offline dF fyziologický): ${noty.length}\n`);

console.log('══ STABILITA: VTL posledního okna vs. offline hodnota TÉHOŽ tónu ══');
console.log('   krok oken 10 ms (jako rámce LPC v aplikaci), okno se mění');
console.log('   okno     |chyba| medián   p90     |rozptyl v tónu|   výtěžnost oken   tónů');

const VYSKY = [];
for (const wS of [4096, 8192, 12288, 16384, 24576, 32768]) {
  const hop = Math.round(0.010 * sampleRate);
  const chyby = [], rozptyly = [];
  let okno = 0, oknoPro = 0;
  for (const n of noty) {
    const i0 = Math.round(n.t_start * sampleRate), i1 = Math.round(n.t_end * sampleRate);
    const ref = 34300 / (2 * D3([n.f1, n.f2, n.f3]));
    const vals = [];
    for (let end = i0 + wS; end <= i1; end += hop) {
      const F = formantsAt(samples, sampleRate, end - wS, end);
      okno++;
      if (PHY(D3(F))) { oknoPro++; vals.push(34300 / (2 * D3(F))); }
    }
    if (vals.length >= 5) {
      const s = [...vals].sort((a, b) => a - b);
      const med = s[s.length >> 1];
      chyby.push(med - ref);
      rozptyly.push(s[s.length - 1] - s[0]);
    }
  }
  const a = chyby.map(Math.abs).sort((x, y) => x - y);
  const r = rozptyly.sort((x, y) => x - y);
  const row = `   ${String(Math.round(wS / sampleRate * 1000) + ' ms').padStart(7)}  ` +
    `${(a.length ? a[a.length >> 1] : NaN).toFixed(2).padStart(15)}  ` +
    `${(a.length ? a[Math.floor(0.9 * (a.length - 1))] : NaN).toFixed(2).padStart(6)}   ` +
    `${(r.length ? r[r.length >> 1] : NaN).toFixed(2).padStart(14)}   ` +
    `${String(`${oknoPro}/${okno}`).padStart(14)}   ${String(`${chyby.length}/${noty.length}`).padStart(9)}`;
  VYSKY.push({ wS, medChyba: a[a.length >> 1], p90: a[Math.floor(0.9 * (a.length - 1))], tonuPoměr: `${chyby.length}/${noty.length}`, oknoPro, okno });
  console.log(row);
}

console.log('\n══ CENA JEDNOHO OKNA (kolik by stálo držet to v indikátoru) ══');
for (const { wS } of VYSKY) {
  const i0 = Math.round(noty[0]?.t_start * sampleRate) || 0;
  const t0 = performance.now();
  const N = 60;
  for (let i = 0; i < N; i++) formantsAt(samples, sampleRate, i0 + i * 1000, i0 + i * 1000 + wS);
  const ms = (performance.now() - t0) / N;
  console.log(`   okno ${String(Math.round(wS / sampleRate * 1000)).padStart(5)} ms: ${ms.toFixed(2)} ms  →  každých 100 ms to je ${(ms / 100 * 100).toFixed(1)} % jednoho jádra (rozpočet rámce 20 ms = 0,41 ms JS)`);
}
console.log();
